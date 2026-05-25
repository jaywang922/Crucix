// Optional LLM translation cache for display text.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { createHash } from 'crypto';

const CACHE_VERSION = 1;
const SOURCE_VERSION = 'zh-Hant-osint-v1';

function textKey(text, targetLocale) {
  return createHash('sha256').update(`${SOURCE_VERSION}|${targetLocale}|${text}`).digest('hex');
}

function compactText(raw, maxLen = 240) {
  return String(raw || '').replace(/\s+/g, ' ').trim().substring(0, maxLen);
}

function loadCache(path) {
  try {
    if (!path || !existsSync(path)) return { version: CACHE_VERSION, entries: {} };
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed?.entries ? parsed : { version: CACHE_VERSION, entries: {} };
  } catch (err) {
    console.warn('[Translation] Cache load failed:', err.message);
    return { version: CACHE_VERSION, entries: {} };
  }
}

function saveCache(path, cache) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(cache, null, 2));
  } catch (err) {
    console.warn('[Translation] Cache save failed:', err.message);
  }
}

function collectTargets(data, maxItems) {
  const targets = [];
  const add = (ref, field, text) => {
    const source = compactText(text);
    if (!source) return;
    targets.push({ ref, field, source, key: textKey(source, 'zh-Hant') });
  };

  for (const item of (data.newsFeed || []).slice(0, Math.max(0, maxItems))) add(item, 'headlineZh', item.headline);
  for (const post of (data.tg?.urgent || []).slice(0, 15)) add(post, 'textZh', post.text);
  for (const post of (data.tg?.topPosts || []).slice(0, 8)) add(post, 'textZh', post.text);
  for (const item of (data.who || []).slice(0, 4)) add(item, 'titleZh', item.title);

  const deduped = [];
  const seen = new Set();
  for (const target of targets) {
    if (seen.has(target.key)) continue;
    deduped.push(target);
    seen.add(target.key);
  }
  return deduped;
}

function applyCachedTranslations(targets, cache) {
  let applied = 0;
  for (const target of targets) {
    const cached = cache.entries[target.key]?.target;
    if (!cached) continue;
    target.ref[target.field] = cached;
    target.ref.translationSource = cache.entries[target.key].provider || 'cache';
    applied += 1;
  }
  return applied;
}

function parseJsonObject(text) {
  if (!text) return null;
  let cleaned = String(text).trim();
  const block = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (block) cleaned = block[1].trim();
  const object = cleaned.match(/\{[\s\S]*\}/);
  if (object) cleaned = object[0];
  try { return JSON.parse(cleaned); } catch { return null; }
}

async function translateBatch(provider, uncached, options) {
  if (!provider?.isConfigured || uncached.length === 0) return {};
  const input = {};
  uncached.forEach((item, index) => {
    input[`t${index}`] = item.source;
  });

  const systemPrompt = [
    'You translate concise OSINT and news dashboard text into Traditional Chinese for Taiwan readers.',
    'Preserve names, tickers, numbers, dates, source labels, and quoted terms when useful.',
    'Use neutral news style. Do not add facts, analysis, warnings, or explanations.',
    'Return only a JSON object with the same keys and translated string values.',
  ].join('\n');

  const result = await provider.complete(systemPrompt, JSON.stringify(input, null, 2), {
    maxTokens: options.maxTokens,
    timeout: options.timeoutMs,
  });
  return parseJsonObject(result?.text) || {};
}

export async function applyChineseTranslations(provider, data, options = {}) {
  const enabled = Boolean(options.enabled);
  const targetLocale = options.targetLocale || 'zh-Hant';
  const cachePath = options.cachePath || join(process.cwd(), 'runs', 'translation-cache.zh.json');
  const maxItems = Number.isFinite(options.maxItems) ? options.maxItems : 30;
  const maxNewPerSweep = Number.isFinite(options.maxNewPerSweep) ? options.maxNewPerSweep : 12;

  if (!enabled || targetLocale !== 'zh-Hant' || !data) {
    return { enabled: false, applied: 0, generated: 0, provider: null };
  }

  const cache = loadCache(cachePath);
  const targets = collectTargets(data, maxItems);
  const applied = applyCachedTranslations(targets, cache);
  const missing = targets.filter(target => !target.ref[target.field]).slice(0, maxNewPerSweep);

  if (!provider?.isConfigured || missing.length === 0) {
    return {
      enabled: true,
      applied,
      generated: 0,
      pending: targets.filter(target => !target.ref[target.field]).length,
      provider: provider?.name || null,
      cacheOnly: !provider?.isConfigured,
    };
  }

  let generated = 0;
  try {
    const translations = await translateBatch(provider, missing, {
      maxTokens: options.maxTokens || 2048,
      timeoutMs: options.timeoutMs || 45000,
    });
    for (let i = 0; i < missing.length; i += 1) {
      const translated = compactText(translations[`t${i}`], 300);
      if (!translated) continue;
      const target = missing[i];
      target.ref[target.field] = translated;
      target.ref.translationSource = provider.name || 'llm';
      cache.entries[target.key] = {
        source: target.source,
        target: translated,
        targetLocale,
        provider: provider.name || 'llm',
        model: provider.model || null,
        createdAt: new Date().toISOString(),
      };
      generated += 1;
    }
    if (generated > 0) saveCache(cachePath, cache);
  } catch (err) {
    console.warn('[Translation] LLM translation failed (non-fatal):', err.message);
  }

  return {
    enabled: true,
    applied,
    generated,
    pending: targets.filter(target => !target.ref[target.field]).length,
    provider: provider?.name || null,
  };
}

import type { Capability } from '../shared/src/types.ts';
export function providerForModel(model: string): string {
  if (model.startsWith('deepseek')) return 'deepseek';
  if (model.startsWith('claude')) return 'claude';
  if (model.startsWith('gemini') || model.startsWith('antigravity')) return 'gemini';
  if (model.startsWith('muse')) return 'muse';
  if (/^(workbuddy|wb|codebuddy)/.test(model)) return 'workbuddy';
  return 'codex';
}

export function capabilitiesForModel(model: string): Capability[] {
  const provider = providerForModel(model);
  if (provider === 'codex') return ['stream','resume','cancel','structured-output'];
  if ((provider === 'workbuddy' || provider === 'muse')) return ['stream','cancel'];
  return ['stream','cancel','structured-output'];
}

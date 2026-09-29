import { z } from 'zod';
import { screenSchema } from './screen.js';

// Tool hosts commonly require named properties on a top-level object. Project
// the shared action union for discovery; execution still validates that union.
const variants = screenSchema.options.map(option => option.shape as Record<string, z.ZodType>);
const names = new Set(variants.flatMap(shape => Object.keys(shape)));
const shape: Record<string, z.ZodType> = {};
// The flat projection cannot mark per-action requirements as required, so descriptions state them.
const descriptions: Record<string, string> = {
  action: 'look observes without input; add capture to look for a short frame sequence (there is no separate capture action). click, move, drag, scroll, type and press send one physical input. back, forward and reload use browser history. wait pauses, then observes.',
  observationId: 'The observationId from the latest screen result. Required for click, move, drag, scroll, type, press, back, forward and reload. Optional for wait. Omit for look.',
  capture: 'Optional for any action: frames 1-10 and intervalMs 20-1000 return that many chronological images after the action.',
  x: 'Viewport image pixel. Required for click, move and drag; for scroll, an optional wheel position paired with y.',
  y: 'Viewport image pixel. Required for click, move and drag; for scroll, an optional wheel position paired with x.',
  toX: 'Drag end in viewport image pixels. Required for drag.',
  toY: 'Drag end in viewport image pixels. Required for drag.',
  deltaX: 'Horizontal wheel delta for scroll. Provide deltaX, deltaY or both; an omitted delta is 0.',
  deltaY: 'Vertical wheel delta for scroll. Provide deltaX, deltaY or both; an omitted delta is 0.',
  text: 'Required for type: literal text typed into the focused element.',
  key: 'Required for press: one editing or navigation key or chord from this enum.',
  milliseconds: 'Required for wait: 0 to 10000.',
};

for (const name of names) {
  const fields = variants.flatMap(variant => variant[name] ? [variant[name]!] : []);
  const unique = new Map<string, z.ZodType>();
  for (const field of fields) {
    const value = field instanceof z.ZodOptional ? field.unwrap() as z.ZodType : field;
    unique.set(JSON.stringify(z.toJSONSchema(value, { io: 'input' })), value);
  }
  const alternatives = [...unique.values()];
  const field = name === 'action'
    ? z.enum(screenSchema.options.map(option => option.shape.action.value))
    : alternatives.length === 1 ? alternatives[0]! : z.union(alternatives);
  const required = fields.length === variants.length && fields.every(value => !value.isOptional());
  shape[name] = (required ? field : field.optional()).describe(descriptions[name] ?? '');
}

/** Provider-facing discovery schema; never substitutes for strict screenSchema execution validation. */
export const screenToolSchema = z.object(shape).strict();

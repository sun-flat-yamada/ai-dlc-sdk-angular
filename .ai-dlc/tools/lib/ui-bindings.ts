import { z } from 'zod';

/**
 * `ui-bindings.yaml` — the single place that connects the HTML/CSS design (by `data-ui-id`)
 * with the REST API (by OpenAPI `operationId`) and with screen states.
 *
 * Expressions (`enabledWhen`, `visibleWhen`, `request` values) use a tiny vocabulary:
 *   state            current screen state
 *   form.<field>     value of an input / toggle bound with `bind`
 *   form.valid       every validated input is valid
 *   device.isOperable  PanelStatusService.isOperable()
 *   response.<path>  body of the last successful response of the event
 * They are specifications for the implementer (AI), not evaluated by the harness.
 */

const id = z.string().regex(/^[a-z][a-z0-9-]*$/, 'kebab-case identifier');

/** API error kinds (ApiError.kind in src/app/core/http/api-error.ts). */
export const ERROR_KINDS = [
  'validation',
  'busy',
  'not-found',
  'timeout',
  'offline',
  'server',
] as const;

const outcomeSchema = z.object({
  /** Next screen state. */
  transition: id.optional(),
  /** UI effect such as `toast.saved`, `banner.deviceBusy`, `fieldErrors`, `navigate:/`. */
  show: z.string().optional(),
  /** Buzzer tone (HardwareBridgeService.beep). */
  feedback: z.enum(['click', 'accept', 'error']).optional(),
});

const actionSchema = outcomeSchema.extend({
  /** OpenAPI operationId to call. Omit for local-only actions. */
  call: z.string().optional(),
  /** Request body mapping: API field -> expression. */
  request: z.record(z.string(), z.string()).optional(),
  /** Path parameters: name -> expression. */
  params: z.record(z.string(), z.string()).optional(),
  /** Navigate to a route (local action). */
  navigate: z.string().optional(),
  success: outcomeSchema.optional(),
  /** Outcome per ApiError kind; `default` covers the others. */
  errors: z.partialRecord(z.enum([...ERROR_KINDS, 'default']), outcomeSchema).optional(),
});

const sourceSchema = z.object({
  call: z.string(),
  /** Polling interval such as `5s` or `500ms`. Omit to load once on screen entry. */
  poll: z
    .string()
    .regex(/^\d+(ms|s)$/)
    .optional(),
  /** Simple JSONPath into the response body (`$.link`, `$.ipv4.address`). */
  path: z
    .string()
    .regex(/^\$(\.[A-Za-z_][\w]*)*$/)
    .default('$'),
});

export const ELEMENT_KINDS = [
  'button',
  'toggle',
  'input',
  'select',
  'indicator',
  'text',
  'list',
  'container',
] as const;

const elementSchema = z.object({
  kind: z.enum(ELEMENT_KINDS),
  label: z.string().optional(),
  description: z.string().optional(),
  /** Form field this control edits (`body.dhcp` -> form.dhcp, sent with `request`). */
  bind: z.string().optional(),
  /** Validation rule name (`ipv4`, `required`, `range:1-100`, `pattern:<regex>`). */
  validate: z.union([z.string(), z.array(z.string())]).optional(),
  enabledWhen: z.string().optional(),
  visibleWhen: z.string().optional(),
  /** Read-only value shown by indicators / texts / lists. */
  source: sourceSchema.optional(),
  /** Value -> CSS class (indicators) or value -> label (texts). */
  map: z.record(z.string(), z.string()).optional(),
  on: z.partialRecord(z.enum(['press', 'longPress', 'change', 'submit']), actionSchema).optional(),
});

const screenSchema = z.object({
  title: z.string(),
  route: z.string().startsWith('/'),
  /** Requirement IDs this screen implements (traceability). */
  requirements: z.array(z.string()).default([]),
  /** HTML file of the design, relative to `.ai-dlc/inputs/ui-design/`. */
  design: z.string(),
  states: z.array(id).min(1),
  initial: id,
  onEnter: actionSchema.optional(),
  elements: z.record(id, elementSchema),
  /** `data-ui-id`s in the design that are purely decorative / static. */
  static: z.array(id).default([]),
});

export const uiBindingsSchema = z.object({
  version: z.literal(1),
  /** OpenAPI documents, relative to `.ai-dlc/inputs/api-specs/`. */
  apiSpecs: z.array(z.string()).min(1),
  screens: z.record(id, screenSchema),
});

export type UiBindings = z.infer<typeof uiBindingsSchema>;
export type ScreenBinding = z.infer<typeof screenSchema>;
export type ElementBinding = z.infer<typeof elementSchema>;
export type ActionBinding = z.infer<typeof actionSchema>;

/** Every operationId referenced by a screen. */
export function referencedOperations(screen: ScreenBinding): string[] {
  const ops: string[] = [];
  const fromAction = (a?: ActionBinding) => {
    if (a?.call) ops.push(a.call);
  };
  fromAction(screen.onEnter);
  for (const el of Object.values(screen.elements)) {
    if (el.source) ops.push(el.source.call);
    for (const a of Object.values(el.on ?? {})) fromAction(a);
  }
  return [...new Set(ops)];
}

import { HttpError, badRequest, isAdmin, type ApiEvent } from './http';

export type Effort = 'low' | 'medium' | 'high';
const EFFORTS: readonly Effort[] = ['low', 'medium', 'high'];

/** Model ids an admin may route a request to, set at deploy time (MODEL_OVERRIDES). */
const ALLOWED = (process.env.MODEL_OVERRIDES ?? '')
  .split(',')
  .map((m) => m.trim())
  .filter(Boolean);

export interface ModelChoice {
  model?: string;
  effort?: Effort;
}

/**
 * A per-request model and effort, for comparing models on the real code path
 * before switching the deployed default — the same retrieval, prompts and
 * grounding, so only the model differs.
 *
 * Admins only, and only to ids on the deploy-time allow-list: an open override
 * would let any account route spend to any model OpenRouter sells.
 */
export function modelOverride(event: ApiEvent, body: { model?: unknown; effort?: unknown }): ModelChoice | undefined {
  if (body.model === undefined && body.effort === undefined) return undefined;
  if (!isAdmin(event)) throw new HttpError(403, 'model overrides are for administrators');
  const choice: ModelChoice = {};
  if (body.model !== undefined) {
    if (typeof body.model !== 'string' || !ALLOWED.includes(body.model)) {
      throw badRequest(`model must be one of: ${ALLOWED.join(', ') || '(none configured)'}`);
    }
    choice.model = body.model;
  }
  if (body.effort !== undefined) {
    if (!EFFORTS.includes(body.effort as Effort)) throw badRequest(`effort must be one of: ${EFFORTS.join(', ')}`);
    choice.effort = body.effort as Effort;
  }
  return choice;
}

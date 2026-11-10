// @naf-sheets/basecamp — typed Basecamp 5 API client (spec §9, Appendix A).
// No IO besides the injected `fetch`. See OPEN_QUESTIONS.md for what is unsettled.

export {
  createBasecampClient,
  DEFAULT_USER_AGENT,
  findTodosetId,
  NAF_WEBHOOK_TYPES,
  subtaskCreateBody,
  subtaskPatchBody,
  todoWriteBody,
  type AttachmentUpload,
  type BasecampClient,
  type BasecampClientOptions,
  type ClientUsersChange,
  type EnrollmentRequest,
  type NewClient,
  type NewPerson,
  type ProjectAccessChange,
  type TodoListFilter,
  type WebhookCreate,
  type WebhookType,
  type WebhookUpdate,
} from './client'
export {
  type CacheEntry,
  type Conditional,
  type ConditionalCache,
  DEFAULT_RETRY_POLICY,
  type FetchInit,
  type FetchLike,
  type FetchResponse,
  parseRetryAfter,
  type RetryPolicy,
} from './http'
export { createTokenBucketLimiter, DEFAULT_RATE_PER_SECOND, type RateLimiter, type TokenBucketOptions } from './limiter'
export { NormaliseError, normaliseSubtask, normaliseTodo } from './normalise'
export { type Page, type Paged, parseNextLink, parseTotalCount } from './pagination'
export * from './errors'
export type * from './raw'

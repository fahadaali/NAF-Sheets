# @naf-sheets/basecamp — open questions

Each item is marked `// OPEN:` in the code. Where the spec and the official docs
(`basecamp/bc-api`, master, read 2026-11-10) disagree or say nothing, the client
does the narrowest safe thing and the question stays here until someone decides.

## Needs a decision

1. **`position` can be missing; the shared type cannot say so.**
   The documented `GET /todos/{id}.json` example has no `position` key, and the
   official SDK schema (`basecamp-sdk/openapi.json`) marks it optional on both
   `Todo` and `Subtask`. `RemoteTodo.position` / `RemoteSubtask.position` in
   `packages/shared` are plain `number`. The normalisers return
   `POSITION_UNKNOWN` (0) when it is absent. Positions are 1-based, so 0 is
   never real, but the sync engine must treat 0 as "unknown" and never diff it.
   Cleaner: make the shared field `number | null`. (`src/normalise.ts`)

2. **Retrying a create after a 5xx can duplicate it.**
   The spec says to retry 5xx with backoff, and the client does, for every
   method. A 500 that arrives after Basecamp committed a `POST` (to-do, subtask,
   list, comment, webhook, project) creates a second one on retry. The
   idempotency rule in spec §9.1 (check `bc_recording_id` before creating) does
   not cover a create whose response was lost. Options: keep it, or stop
   retrying creates in the client and have the engine look for the record
   before creating again. (`src/http.ts`)

3. **Which 5xx are retried.**
   The spec says "5xx"; the README lists 500, 502, 503 and 504 as retryable.
   Only those four are retried (at most 5 attempts, 1 s doubling, capped at 30 s).
   507 is `LimitReachedError`. Any other 5xx (501, 505…) is thrown at once as a
   `ServerError` with `retryable: false`. (`src/http.ts`)

4. **To-do list groups and loose to-dos.**
   - A to-do inside a list *group* has the group as `parent` (a group is also
     `type: "Todolist"`, per the SDK schema). `listId` is then the group's id,
     not the sheet's list. Whether `GET /todolists/{id}/todos.json` includes
     grouped to-dos is not documented. Groups are not handled.
   - A loose to-do directly in the to-do set (`parent.type` = `Todoset`) has no
     sheet. The normaliser refuses it rather than mapping it to a wrong list.
   (`src/normalise.ts`)

5. **Limits the spec does not give.**
   429: at most 5 attempts; a `Retry-After` longer than 60 s is not slept
   in-process but thrown as `RateLimitedError.retryAfterMs` for the queue to
   delay. A 429 without `Retry-After` backs off like a 5xx. All three numbers
   are options (`retry`). (`src/http.ts`)

6. **Network failures** (`fetch` itself throws) are not covered by the docs.
   They are thrown once as `NetworkError` (`retryable: true`) and not retried
   in the client; the queue's own retry (spec §9.2.8) decides. (`src/http.ts`)

7. **Rate limiter scope.**
   The token bucket (4/s, burst 4: at most 44 per 10 s against Basecamp's 50)
   is shared by every client built in one Worker isolate. Several isolates are
   not bounded together; a global limit needs a Durable Object behind the
   `RateLimiter` interface. (`src/limiter.ts`)

8. **Cache scope for conditional GET.**
   Responses depend on whose token asked (emails are redacted for non-admins),
   so conditional GET is opt-in per call with a `cacheScope` chosen by the
   caller (e.g. `"service"` for reconciliation). Keys are `scope` + URL, never
   the token. Which scopes the API uses is its decision.

## Needs the live Basecamp test (`spike/basecamp/`)

9. **`"due_on": null` / `"starts_on": null` on `PUT /todos/{id}.json`.**
   The docs say an omitted field is cleared but never show null on this
   endpoint; the SDK types the dates as non-nullable strings here, while it
   marks subtask `due_on` as clearable. The client always sends all six fields
   (CLAUDE.md), so it sends null for a cleared date. Confirm Basecamp accepts it
   and clears the date. (`src/client.ts`, `todoWriteBody`)

10. **Restoring from the trash.**
    `PUT /recordings/{id}/status/active.json` is documented as "Unarchive a
    recording". That it also restores from the trash is documented only for
    projects. `recordings.restore` uses it for both. (`src/client.ts`)

11. **429 on `PUT /projects/{id}/people/client_users.json`.**
    The docs use 429 for "the new addresses would exceed the user limit",
    which collides with 429 as rate limit. On this endpoint only, a 429 without
    `Retry-After` is thrown as `LimitReachedError` without retrying; with
    `Retry-After` it is treated as a rate limit. Confirm which headers that
    answer carries. (`src/client.ts`, `src/http.ts`)

12. **`PUT /webhooks/{id}.json` partial or full?** Not documented (only
    `payload_url` is required). `WebhookUpdate` requires `payloadUrl`, `types`
    and `active`, and all three are always sent. (`src/client.ts`)

## Spec rule the docs override

13. **Attachment upload Content-Type.** Spec §9.2.10 requires
    `Content-Type: application/json; charset=utf-8` on every POST.
    `POST /attachments.json` takes the raw file bytes with the file's own
    `Content-Type` and `Content-Length` (attachments.md); JSON there cannot work.
    The client follows the docs for this one endpoint. (`src/client.ts`)

## Smaller notes

- **More than one enabled to-do set** in a project's `dock` is refused
  (`findTodosetId` throws); the README says there is exactly one.
- **Subtask create** omits `due_on` when it is null (optional in the docs);
  subtask *update* sends `"due_on": null` to clear, as documented.
- **Enrollment** (`POST /account/enrollments/people.json`) silently ignores
  `project_ids` the caller cannot manage: a 201 does not prove every project
  was granted. Check the project's people afterwards.
- **`RemoteSubtask`** has no `status`, `bucketId` or `creatorId`; the raw
  subtask has them (`RawSubtask`) if the engine needs them.
- **Not wrapped:** `POST/DELETE /projects/{id}/client_enablement.json`. Spec
  §8.2 says the platform never enables clients by itself; add it only with
  that decision.
- **Redirects** are never followed (`redirect: 'manual'`), so the token cannot
  travel to another host; a 3xx is an error. No wrapped endpoint documents one.

// POST /api/workbooks/:id/tasks/:uid/attachments?name=… (packages/shared/src/api-phase5.ts):
// the file's bytes as the request body, with upload progress. `fetch` reports
// no upload progress, so this one request uses XMLHttpRequest; its answers and
// failures are read exactly as the rest of the API client reads them.

import type { UploadAttachmentResponse } from '@naf-sheets/shared'
import { t } from '../strings'
import { ApiRequestError, redirectToLogin, toApiRequestError } from './api'

export interface UploadOptions {
  /** Bytes sent so far, of `total`. */
  onProgress?: (loaded: number, total: number) => void
  signal?: AbortSignal
}

export function uploadPath(workbookId: string, uid: string, name: string): string {
  return `/api/workbooks/${encodeURIComponent(workbookId)}/tasks/${encodeURIComponent(uid)}/attachments?name=${encodeURIComponent(name)}`
}

function parse(text: string): unknown {
  if (!text) return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

export function uploadAttachment(workbookId: string, uid: string, file: File, options: UploadOptions = {}): Promise<UploadAttachmentResponse> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new DOMException('aborted', 'AbortError'))
      return
    }
    const xhr = new XMLHttpRequest()
    xhr.open('POST', uploadPath(workbookId, uid, file.name))
    xhr.setRequestHeader('Accept', 'application/json')
    // The file's own type; the browser sets Content-Length from the file.
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream')
    xhr.upload.onprogress = (e) => options.onProgress?.(e.loaded, e.lengthComputable ? e.total : file.size)
    xhr.onload = () => {
      const payload = parse(xhr.responseText)
      if (xhr.status >= 200 && xhr.status < 300 && typeof payload === 'object' && payload !== null) {
        options.onProgress?.(file.size, file.size)
        resolve(payload as UploadAttachmentResponse)
        return
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        reject(new ApiRequestError(xhr.status, 'invalid_response', t.errors.invalidResponse))
        return
      }
      if (xhr.status === 401) {
        const login = typeof payload === 'object' && payload !== null && typeof (payload as { login?: unknown }).login === 'string' ? (payload as { login: string }).login : undefined
        redirectToLogin(login)
      }
      reject(toApiRequestError(xhr.status, payload))
    }
    xhr.onerror = () => reject(new ApiRequestError(0, 'network_error', t.errors.network))
    xhr.onabort = () => reject(new DOMException('aborted', 'AbortError'))
    options.signal?.addEventListener('abort', () => xhr.abort(), { once: true })
    xhr.send(file)
  })
}

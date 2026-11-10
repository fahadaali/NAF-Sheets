// Who is in the workbook, and the state of the realtime connection (spec §11:
// "صور المستخدمين المتصلين أعلى الملف"). Avatars show initials in each
// person's presence colour (the same colour frames their cell in the grid).

import { CloudCheck, LoaderCircle, RefreshCw, Users, WifiOff } from 'lucide-react'
import { initials, presenceColour } from './presence'
import { collabText } from './strings'
import type { CollabView } from './session'

/** Avatars shown before «+n». */
const MAX_AVATARS = 5

export function PresenceBar({ view }: { view: CollabView }) {
  if (view.mode === 'unavailable') return null
  const editing = new Set(view.locks.map((l) => l.connectionId))
  const shown = view.peers.slice(0, MAX_AVATARS)
  const hidden = view.peers.length - shown.length
  return (
    <div className="presence" data-testid="presence" data-peers={view.peers.length} data-room-mode={view.mode}>
      <RoomStatus view={view} />
      {view.peers.length > 0 ? (
        <ul className="presence__list" aria-label={collabText.peers}>
          {shown.map((peer) => {
            const label = collabText.peer(peer.name, editing.has(peer.connectionId), peer.readOnly)
            return (
              <li key={peer.connectionId} className="presence__item">
                <span
                  className={`avatar presence__avatar presence__avatar--${presenceColour(peer.connectionId) + 1}${editing.has(peer.connectionId) ? ' is-editing' : ''}`}
                  title={label}
                  aria-label={label}
                  role="img"
                  data-testid="presence-avatar"
                  data-user-id={peer.userId}
                >
                  {initials(peer.name)}
                </span>
              </li>
            )
          })}
          {hidden > 0 ? (
            <li className="presence__item">
              <span className="avatar presence__avatar presence__avatar--more">
                <bdi>{collabText.more(hidden)}</bdi>
              </span>
            </li>
          ) : null}
        </ul>
      ) : (
        <Users className="icon" aria-hidden="true" />
      )}
    </div>
  )
}

function RoomStatus({ view }: { view: CollabView }) {
  const look =
    view.mode === 'live'
      ? view.pending > 0
        ? { Icon: LoaderCircle, label: collabText.status.sending, spin: true }
        : { Icon: CloudCheck, label: collabText.status.live, spin: false }
      : view.mode === 'connecting'
        ? { Icon: LoaderCircle, label: collabText.status.connecting, spin: true }
        : view.mode === 'resyncing'
          ? { Icon: RefreshCw, label: collabText.status.resyncing, spin: true }
          : view.mode === 'offline'
            ? { Icon: WifiOff, label: collabText.status.offline, spin: false }
            : { Icon: WifiOff, label: collabText.status.failed, spin: false }
  const { Icon } = look
  return (
    <span className={`room-status room-status--${view.mode}`} role="status" aria-live="polite" data-testid="room-status">
      <Icon className={look.spin ? 'icon spin' : 'icon'} aria-hidden="true" />
      {look.label}
    </span>
  )
}

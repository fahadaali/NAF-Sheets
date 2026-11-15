import { useEffect, useState } from 'react'
import type { CurrentUser } from '@naf-sheets/shared'
import { api } from './lib/api'
import { applyPalette } from './lib/theme-colors'
import { useRoute } from './lib/router'
import { DeniedScreen, NotFoundScreen } from './screens/MessageScreens'
import { MembersScreen } from './screens/MembersScreen'
import { SettingsScreen } from './screens/SettingsScreen'
import { AppearanceScreen } from './screens/AppearanceScreen'
import { LinkScreen, LinksScreen, NamesScreen, NewLinkScreen } from './station/screens'
import './station/station.css'

/**
 * The signed-in user, for the app bar and for hiding actions a platform
 * viewer cannot take. `settled` turns true once /api/me answered or failed.
 */
function useCurrentUser(enabled: boolean): { user: CurrentUser | null; settled: boolean } {
  const [state, setState] = useState<{ user: CurrentUser | null; settled: boolean }>({ user: null, settled: false })
  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    // A 401 redirects to sign-in inside the client; any other failure only
    // means the name is not shown: every screen still works, and the API
    // enforces permissions on its own.
    api.me(controller.signal).then(
      (res) => setState({ user: res.user, settled: true }),
      () => {
        if (!controller.signal.aborted) setState({ user: null, settled: true })
      },
    )
    return () => controller.abort()
  }, [enabled])
  return state
}

/** The admins' palette overrides («المظهر»), applied once at load; theme.css stays in force without them. */
function useAppearance(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    api.getAppearance(controller.signal).then(
      (res) => applyPalette(res.palette),
      () => undefined,
    )
    return () => controller.abort()
  }, [enabled])
}

export function App() {
  const route = useRoute()
  const { user, settled } = useCurrentUser(route.name !== 'denied')
  useAppearance(route.name !== 'denied')

  switch (route.name) {
    case 'stationLinks':
      return <LinksScreen user={user} />
    case 'stationNew':
      return <NewLinkScreen user={user} />
    case 'stationLink':
      return <LinkScreen key={route.id} user={user} id={route.id} />
    case 'stationNames':
      return <NamesScreen user={user} focusName={route.focusName} suggest={route.suggest} />
    case 'settings':
      return <SettingsScreen user={user} />
    case 'members':
      return <MembersScreen user={user} userSettled={settled} />
    case 'appearance':
      return <AppearanceScreen user={user} userSettled={settled} />
    case 'denied':
      return <DeniedScreen reason={route.reason} />
    case 'notFound':
      return <NotFoundScreen user={user} />
  }
}

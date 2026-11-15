// The platform's header: NAF's logo and the platform's name, the main
// sections, and who is signed in. The current section is marked.

import { ArrowLeftRight, Settings, Users } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { CurrentUser } from '@naf-sheets/shared'
import { Link, useRoute } from '../lib/router'
import type { Route } from '../lib/routes'
import { t } from '../strings'

type Section = 'links' | 'names' | 'settings' | null

function sectionOf(route: Route): Section {
  switch (route.name) {
    case 'stationLinks':
    case 'stationNew':
    case 'stationLink':
      return 'links'
    case 'stationNames':
      return 'names'
    case 'settings':
    case 'members':
    case 'appearance':
      return 'settings'
    default:
      return null
  }
}

const SECTIONS: { id: Exclude<Section, null>; href: string; label: string; Icon: LucideIcon }[] = [
  { id: 'links', href: '/', label: t.nav.links, Icon: ArrowLeftRight },
  { id: 'names', href: '/names', label: t.nav.names, Icon: Users },
  { id: 'settings', href: '/settings', label: t.nav.settings, Icon: Settings },
]

/** First letter of the name (skipping «ال» and spaces), for the avatar. */
function initial(name: string): string {
  const word = name.trim().replace(/^ال/, '')
  return [...word][0] ?? ''
}

export function AppBar({ user }: { user: CurrentUser | null; showSettings?: boolean }) {
  const current = sectionOf(useRoute())
  const who = user?.name || user?.email
  return (
    <header className="app-bar">
      <Link href="/" className="app-bar__brand" aria-label={t.appName}>
        <img src="/brand/naf-logo-light.png" alt={t.brand.logoAlt} className="app-bar__logo" width="63" height="32" />
        <span className="app-bar__name">
          <strong>{t.appName}</strong>
          <span className="app-bar__tagline">{t.brand.tagline}</span>
        </span>
      </Link>
      <nav className="app-bar__nav" aria-label={t.nav.label}>
        {SECTIONS.map(({ id, href, label, Icon }) => (
          <Link key={id} href={href} className="app-bar__nav-link" aria-current={current === id ? 'page' : undefined}>
            <Icon className="icon" aria-hidden="true" />
            <span>{label}</span>
          </Link>
        ))}
      </nav>
      {who ? (
        <span className="app-bar__user" title={who}>
          <span className="app-bar__avatar" aria-hidden="true">
            {initial(who)}
          </span>
          <span className="sr-only">{t.signedInAs} </span>
          <bdi>{who}</bdi>
        </span>
      ) : null}
    </header>
  )
}

import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'

/** Renders `fallback` instead of a subtree that threw while rendering (e.g. a lazy chunk that failed to load). */
export class ErrorBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('[web] render failed', error, info.componentStack)
  }

  override render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

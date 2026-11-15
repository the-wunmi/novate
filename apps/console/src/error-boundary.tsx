import { Component, type ReactNode } from 'react';

/** A page that throws shows a way out instead of a blank screen. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="panel">
        <div className="panel-body">
          <p>Something went wrong on this page.</p>
          <button type="button" className="btn" onClick={() => location.reload()}>
            Reload
          </button>
        </div>
      </div>
    );
  }
}

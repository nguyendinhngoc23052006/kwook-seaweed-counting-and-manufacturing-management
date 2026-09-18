import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

// Scoped to the org-admin section only -- the device/wall/admin pages have
// their own long-standing error handling and are left untouched.
export class OrgErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: unknown) {
    console.error("[OrgErrorBoundary]", error, info);
  }

  reset = () => this.setState({ error: null });

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="min-h-screen flex items-center justify-center p-6 bg-surface-sunken">
        <div className="max-w-md rounded-lg bg-surface-raised p-6 shadow-md">
          <h1 className="mb-2 text-xl font-bold text-ink">Something broke</h1>
          <p className="mb-4 text-sm text-ink-muted">
            {this.state.error.message || "Unknown error"}
          </p>
          <button
            type="button"
            onClick={this.reset}
            className="rounded bg-accent px-4 py-2 text-sm font-medium text-accent-on hover:bg-accent-strong"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }
}

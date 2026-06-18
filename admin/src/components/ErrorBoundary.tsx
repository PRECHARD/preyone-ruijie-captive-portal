import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  section?: string;
  onNavigate?: (section: string) => void;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('ErrorBoundary caught:', error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="page">
          <div className="page-header">
            <h2 className="page-title">Something went wrong</h2>
            <p className="page-desc">{this.state.error?.message || 'An unexpected error occurred'}</p>
          </div>
          <div className="card" style={{ padding: 24, textAlign: 'center' }}>
            <p style={{ color: 'var(--text-muted)', marginBottom: 16 }}>
              Try refreshing the page. If the issue persists, contact support.
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
              <button className="btn-primary" onClick={() => window.location.reload()}>
                Refresh Page
              </button>
              {this.props.section && this.props.onNavigate && (
                <button className="btn-secondary" onClick={() => { this.setState({ hasError: false, error: null }); this.props.onNavigate!(this.props.section!); }}>
                  Go to {this.props.section}
                </button>
              )}
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.js';
import './styles.css';

/** 根级错误边界：渲染异常时保留可见的错误提示，避免整窗白屏无任何反馈。 */
class RootErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('应用渲染异常', error, info.componentStack);
  }

  render() {
    if (this.state.error !== null) {
      return (
        <div style={{ padding: '24px', color: '#e74c3c', fontSize: '14px' }}>
          应用出现异常：{this.state.error.message}
          <br />
          请重启应用重试。
        </div>
      );
    }
    return this.props.children;
  }
}

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('未找到 #root 挂载节点');
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <RootErrorBoundary>
      <App />
    </RootErrorBoundary>
  </React.StrictMode>,
);

import type { Workspace } from '../workspace';

interface WorkspaceSwitcherProps {
  workspace: Workspace;
  onChange: (workspace: Workspace) => void;
}

export default function WorkspaceSwitcher({ workspace, onChange }: WorkspaceSwitcherProps) {
  return (
    <div className="workspace-switch" role="tablist" aria-label="Workspace">
      <button type="button" role="tab" aria-selected={workspace === 'ultranet'} data-ws="ultranet" className={'ws-btn' + (workspace === 'ultranet' ? ' active' : '')} onClick={() => onChange('ultranet')} title="Preyone UltraNet WiFi">
        <span className="ws-icon"><img src="/favicon.svg" alt="Preyone UltraNet WiFi" className="ws-logo ws-logo--favicon" /></span>
        <span className="ws-label">Preyone UltraNet WiFi</span>
      </button>
      <button type="button" role="tab" aria-selected={workspace === 'transit'} data-ws="transit" className={'ws-btn' + (workspace === 'transit' ? ' active' : '')} onClick={() => onChange('transit')} title="Preyone Transit Operations">
        <span className="ws-icon"><img src="/images/preyone-green-logo.png" alt="Preyone Transit Operations" className="ws-logo ws-logo--transit" /></span>
        <span className="ws-label">Preyone Transit Operations</span>
      </button>
      <button type="button" role="tab" aria-selected={workspace === 'pos'} data-ws="pos" className={'ws-btn' + (workspace === 'pos' ? ' active' : '')} onClick={() => onChange('pos')} title="Preyone POS (Point of Sale)">
        <span className="ws-icon"><img src="/favicon.svg" alt="Preyone POS" className="ws-logo ws-logo--favicon" /></span>
        <span className="ws-label">Preyone POS</span>
      </button>
    </div>
  );
}
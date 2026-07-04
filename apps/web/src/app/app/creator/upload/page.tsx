import ShellPage from '../../../../workspaces/ShellPage';
import { workspaceFor } from '../../../../workspaces/config';

// Loop OS — Creator · Upload Video (Phase 2, PR #47).
//
// A FIRST-CLASS creator surface. Creators upload content for review here; a
// later PR plugs Brain analysis and AI critiques into this exact page. Phase 2
// builds only the workspace — no AI review, no processing, no storage wiring.
// The upload control below is an inert shell affordance (no handler), present
// so the information architecture is real and reviewable.

export default function CreatorUploadPage() {
  const ws = workspaceFor('CREATOR');
  return (
    <div>
      <div className="ds-pagehead">
        <div className="ds-eyebrow">{ws.label} Workspace · First-class</div>
        <h1 className="ds-title">Upload Video</h1>
        <p className="ds-subtitle">
          Upload content for review. Brain analysis and AI critiques will plug into this page.
        </p>
      </div>

      <div className="ds-card" style={{ marginTop: '1.25rem' }}>
        <div className="ds-card-body">
          <div
            className="ds-empty"
            style={{
              border: '1px dashed var(--ds-border, rgba(255,255,255,0.15))',
              borderRadius: '12px',
              padding: '2.5rem',
              textAlign: 'center',
            }}
          >
            <strong>Drop a video here</strong>
            <div className="ds-subtitle" style={{ margin: '0.35rem 0 1rem' }}>
              MP4, MOV, or WebM · single file · shell only (upload is not wired yet)
            </div>
            <button className="crm-btn-primary" type="button" disabled>
              Select video
            </button>
          </div>

          <ul style={{ marginTop: '1.25rem', paddingLeft: '1.1rem', opacity: 0.85 }}>
            <li>Future: submits into the Content Review Queue.</li>
            <li>Future: Brain analysis produces AI critiques (consumed, not computed here).</li>
            <li>Phase 2 ships the workspace only — no AI review yet.</li>
          </ul>
        </div>
      </div>
    </div>
  );
}

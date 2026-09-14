import type { LoadFailure } from '../demo/db-health';

// Failure state for CRM surfaces, rendered inside the CRM shell.
//
// A failed read is never presented as an empty state — "no activity yet" on a
// page whose query failed would be a fabricated fact. The raw database error is
// not shown: it can carry connection details, and the operator cannot act on it.

export function CrmLoadError({ failure, surface }: { failure: LoadFailure; surface: string }) {
  return (
    <div className="ds-card crm-load-error" role="alert">
      <div className="ds-card-body">
        <h1 className="crm-load-error__title">{surface} is unavailable</h1>
        <p className="crm-load-error__desc">
          {failure.cause === 'not-configured'
            ? 'This environment has no database configured, so no CRM data can be shown here.'
            : 'The data for this page could not be loaded, so nothing is shown rather than a partial view. Try again shortly.'}
        </p>
      </div>
    </div>
  );
}

import type { TtoReport } from '@emgloop/providers';
export function CreatorAudienceInsights({ audience }: { audience: TtoReport['audience'] }) {
  return (
    <section className="ch-audience" aria-label="Your audience">
      <div className="ch-performance-lab__heading">
        <div>
          <p className="ch-performance-kicker">Your audience</p>
          <h2>Who you’re connecting with.</h2>
        </div>
      </div>
      {(['followers', 'reached', 'engaged'] as const).map((key) => (
        <details className="ch-analytics-video-details" key={key} open={key === 'followers'}>
          <summary>
            {key === 'followers'
              ? 'Your followers'
              : key === 'reached'
                ? 'People reached · past 30 days'
                : 'People engaged · past 30 days'}
          </summary>
          <div className="ch-audience-grid">
            {(['ages', 'genders', 'countries'] as const).map((field) => {
              const rows = audience?.[key]?.[field] ?? [];
              return (
                <div key={field}>
                  <h3>
                    {field === 'ages'
                      ? 'Age'
                      : field === 'genders'
                        ? 'Gender'
                        : 'Top countries / regions'}
                  </h3>
                  {rows.length ? (
                    <ul className="ch-audience-bars">
                      {rows.map((row) => (
                        <li key={row.label}>
                          <span>{row.label}</span>
                          <strong>{(row.percentage * 100).toFixed(1)}%</strong>
                          <meter
                            min="0"
                            max="1"
                            value={row.percentage}
                            aria-label={`${row.label} audience share`}
                          />
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="loop-note">
                      {field === 'ages' ? 'Age' : field === 'genders' ? 'Gender' : 'Location'}{' '}
                      breakdown was not returned in this account’s latest reading.
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </details>
      ))}
      <p className="loop-note">
        Reported audience shares are separate populations, not added together. Countries show the
        leading regions returned, not necessarily the whole audience.
      </p>
    </section>
  );
}

import type { ReactNode } from 'react';

export function Card({
  title,
  action,
  children,
  tone = 'default',
}: {
  readonly title?: string;
  readonly action?: ReactNode;
  readonly children: ReactNode;
  readonly tone?: 'default' | 'amber' | 'green' | 'red';
}) {
  return (
    <section className={`card card--${tone}`}>
      {title !== undefined || action !== undefined ? (
        <header className="card__header">
          {title !== undefined ? <h2>{title}</h2> : <span />}
          {action}
        </header>
      ) : null}
      <div className="card__body">{children}</div>
    </section>
  );
}

export function Badge({
  children,
  tone = 'neutral',
}: {
  readonly children: ReactNode;
  readonly tone?: 'neutral' | 'accent' | 'amber' | 'green' | 'red' | 'purple';
}) {
  return <span className={`badge badge--${tone}`}>{children}</span>;
}

export function ScreenHeader({
  eyebrow,
  title,
  detail,
  action,
}: {
  readonly eyebrow: string;
  readonly title: string;
  readonly detail?: string;
  readonly action?: ReactNode;
}) {
  return (
    <header className="screen-header">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
        {detail !== undefined ? <p>{detail}</p> : null}
      </div>
      {action}
    </header>
  );
}

export function EmptyState({
  title,
  detail,
}: {
  readonly title: string;
  readonly detail: string;
}) {
  return (
    <div className="empty-state">
      <div className="empty-state__mark" aria-hidden="true">
        ◇
      </div>
      <strong>{title}</strong>
      <span>{detail}</span>
    </div>
  );
}

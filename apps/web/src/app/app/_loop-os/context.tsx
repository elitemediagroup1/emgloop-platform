import Link from "next/link";
import { SidebarIcon } from "../../crm/_brand/SidebarIcon";

export type ContextLink = {
  icon: string;
  title: string;
  detail: string;
  href?: string;
};

export function ContextCard(props: ContextLink) {
  const inner = (
    <>
      <span className="loop-ctx__icon">
        <SidebarIcon name={props.icon} />
      </span>
      <span className="loop-ctx__text">
        <span className="loop-ctx__title">{props.title}</span>
        <span className="loop-ctx__detail">{props.detail}</span>
      </span>
      {props.href ? <span className="loop-ctx__go">View &rarr;</span> : null}
    </>
  );

  if (props.href) {
    return (
      <Link href={props.href} className="loop-ctx loop-ctx--link">
        {inner}
      </Link>
    );
  }

  return <div className="loop-ctx">{inner}</div>;
}

export function ContextGroup(props: {
  title?: string;
  caption?: string;
  links: ContextLink[];
  emptyTitle?: string;
  emptyBody?: string;
}) {
  const hasLinks = props.links.length > 0;
  return (
    <div className="loop-card loop-ctxgroup">
      <div className="loop-card__head">
        <p className="loop-card__title">{props.title || "Related"}</p>
      </div>
      {props.caption ? <p className="loop-ctxgroup__caption">{props.caption}</p> : null}
      {hasLinks ? (
        <div className="loop-ctxgroup__list">
          {props.links.map((link, i) => (
            <ContextCard key={link.title + i} {...link} />
          ))}
        </div>
      ) : (
        <div className="loop-empty loop-ctxgroup__empty">
          <span className="loop-ctx__icon">
            <SidebarIcon name="flow" />
          </span>
          <p className="loop-empty__title">{props.emptyTitle || "No related context yet"}</p>
          <p className="loop-empty__body">
            {props.emptyBody || "Connections appear here as data flows through Loop."}
          </p>
        </div>
      )}
    </div>
  );
}

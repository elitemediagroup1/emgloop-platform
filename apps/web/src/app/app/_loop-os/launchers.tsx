import Link from "next/link";
import { SidebarIcon } from "../../crm/_brand/SidebarIcon";

export function ActionTile(props: { icon: string; title: string; desc: string; href: string }) {
  return (
    <Link href={props.href} className="loop-launch">
      <span className="loop-launch__icon"><SidebarIcon name={props.icon} /></span>
      <span className="loop-launch__title">{props.title}</span>
      <span className="loop-launch__desc">{props.desc}</span>
    </Link>
  );
}

import { redirect } from "next/navigation";
import { requireWorkspacePermission } from "../../../../workspaces/guard";

// Retired route — kept only so existing bookmarks and deep links resolve.
//
// /app/admin/brain and /app/admin/marketplace rendered the SAME Executive Brain
// from the SAME reasoning path — two surfaces for one command center. The
// Overview at /app/admin/marketplace is now the single executive command center;
// this route enforces the same IAM gate and forwards to it. No duplicate
// implementation, and nothing the old page showed is lost — the Overview carries
// the Executive Brain, the Evidence Sources panel and the Live Calls feed.
//
// Mirrors the /app/admin/marketplace-intelligence redirect (same pattern).

export const dynamic = "force-dynamic";

export default async function ExecutiveBrainRedirect() {
  // Preserve the original authorization semantics before forwarding.
  await requireWorkspacePermission("ADMIN", "intelligence", "view");
  redirect("/app/admin/marketplace");
}

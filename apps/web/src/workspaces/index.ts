// Loop OS — Phase 2 workspace layer barrel (PR #47).
//
// The operating-system shell that Loop's functionality will live inside. It
// reuses the existing Brain architecture, auth, and IAM; it never duplicates
// them. Config-driven role -> workspace -> nav -> route with server-side guards.
export * from './config';
export * from './role-router';
export { default as WorkspaceShell } from './WorkspaceShell';
export { default as ShellPage } from './ShellPage';
export * from './guard';
export * from './verification';

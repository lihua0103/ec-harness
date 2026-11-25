/** Shared slot-occupant components for the enterprise workbench (T02/T06/T12). */
import type { ReactNode } from 'react'
import type { SidebarBrandMarkOwnerProps, SidebarBrandNameOwnerProps, SidebarPanelIconOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'

/** Panel ids shared by the sidebar entries and their keyed `main` pages. */
export const EMERALD_PANEL_ID = 'emerald-workbench'
export const EMERALD_PANEL_IDS = {
  works: 'emerald-works',
  projects: 'emerald-projects',
  apps: 'emerald-apps',
  pending: 'emerald-pending',
  settings: 'emerald-settings',
} as const

/** Emerald mark for the sidebar brand row; drawn inline so the package ships no assets. */
export function EmeraldBrandMark({ size }: SidebarBrandMarkOwnerProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" role="img" aria-label="EMERALD">
      <path d="M12 2 3 9v6l9 7 9-7V9z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M12 6.5 8 9.5v5l4 3 4-3v-5z" fill="currentColor" />
    </svg>
  )
}

/** Brand name for the sidebar row. */
export function EMERALD_BRAND_NAME(_props: SidebarBrandNameOwnerProps) {
  return <span className="emerald-brand-name">EMERALD 企业 AI</span>
}

const icon = (label: string, size: number, active: boolean, paths: ReactNode) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    role="img"
    aria-label={label}
    style={{ opacity: active ? 1 : 0.72 }}
  >
    {paths}
  </svg>
)

/** Sidebar navigation icon for the workbench panel; `active` marks the current panel. */
export function EmeraldPanelIcon({ size, active }: SidebarPanelIconOwnerProps) {
  return icon('我的工作', size, active, (
    <>
      <rect x="3" y="4" width="7" height="7" rx="1.4" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <rect x="14" y="4" width="7" height="7" rx="1.4" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <rect x="3" y="15" width="18" height="5" rx="1.4" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </>
  ))
}

/** 项目空间: folder with a tab. */
export function ProjectsIcon({ size, active }: SidebarPanelIconOwnerProps) {
  return icon('项目空间', size, active,
    <path d="M3 7h7l2-3h8v16H3zM3 9h17" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />)
}

/** 应用中心: four application tiles. */
export function AppsIcon({ size, active }: SidebarPanelIconOwnerProps) {
  return icon('应用中心', size, active, (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </>
  ))
}

/** 待处理: a clock with a pending dot. */
export function PendingIcon({ size, active }: SidebarPanelIconOwnerProps) {
  return icon('待处理', size, active, (
    <>
      <circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M12 7.5V12l3 2" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </>
  ))
}

/** 历史会话: a speech bubble. */
export function SessionsIcon({ size, active }: SidebarPanelIconOwnerProps) {
  return icon('历史会话', size, active,
    <path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5 8.5 8.5 0 0 1-3.8-.9L3 21l1.9-5.7a8.5 8.5 0 1 1 16.1-3.8z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />)
}

/** 平台设置: gear. */
export function SettingsIcon({ size, active }: SidebarPanelIconOwnerProps) {
  return icon('平台设置', size, active, (
    <>
      <circle cx="12" cy="12" r="3.4" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </>
  ))
}

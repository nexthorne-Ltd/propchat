import React from 'react';
import { WorkspacesView } from '@/components/admin/WorkspacesView';

export const metadata = {
  title: 'Workspaces — Zentry Super Admin',
  description: 'Manage and monitor all tenant workspaces across the platform.',
};

export default function AdminWorkspacesPage() {
  return <WorkspacesView />;
}

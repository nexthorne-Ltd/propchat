import React from 'react';
import { OverviewView } from '@/components/admin/OverviewView';

export const metadata = {
  title: 'Platform Overview — Zentry Super Admin',
  description: 'Manage platform workspaces, activity trends, and system performance metrics.',
};

export default function AdminOverviewPage() {
  return <OverviewView />;
}

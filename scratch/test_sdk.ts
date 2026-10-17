import { Vercel } from '@vercel/sdk';

const token = process.env.VERCEL_TOKEN || process.env.VERCEL_API_TOKEN;
const projectId = process.env.VERCEL_PROJECT_ID;
const teamId = process.env.VERCEL_TEAM_ID;

console.log('Token exists:', !!token);
console.log('ProjectId exists:', !!projectId);
console.log('TeamId exists:', !!teamId);

if (!token) throw new Error('Missing VERCEL_TOKEN');
if (!projectId) throw new Error('Missing VERCEL_PROJECT_ID');

const vercel = new Vercel({ bearerToken: token });

async function run() {
  try {
    console.log('Calling addProjectDomain...');
    const res = await vercel.projects.addProjectDomain({
      idOrName: projectId!,
      teamId: teamId || undefined,
      requestBody: { name: 'help.genzprop.com' },
    });
    console.log('addProjectDomain result:', res);
  } catch (err: any) {
    console.error('addProjectDomain error code:', err?.code, 'message:', err?.message, 'statusCode:', err?.statusCode);
  }
}

run();

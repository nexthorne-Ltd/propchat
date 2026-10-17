async function testHeader() {
  const res = await fetch('http://localhost:3000');
  const html = await res.text();
  console.log('Homepage status:', res.status);
  console.log('Contains "Help Center":', html.includes('Help Center'));
  console.log('Contains href="/help":', html.includes('/help'));

  const helpRes = await fetch('http://localhost:3000/help', { redirect: 'manual' });
  console.log('Help route status:', helpRes.status, 'Target location:', helpRes.headers.get('location'));
}

testHeader().catch(console.error);

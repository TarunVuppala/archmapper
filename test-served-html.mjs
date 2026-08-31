import('./dist/ui/server.js').then(async ({startUIServer}) => {
  // Start on test port
  await startUIServer(4567);
  
  // Wait for server to be ready
  await new Promise(r => setTimeout(r, 500));
  
  // Fetch the page
  const resp = await fetch('http://127.0.0.1:4567/');
  const html = await resp.text();
  
  // Check if the init function calls d3.json
  const hasInit = html.includes('async function init()');
  const hasD3Json = html.includes("d3.json('/api/graph')");
  const hasD3Select = html.includes('d3.select("svg#visualizer")');
  
  console.log('Has init():', hasInit);
  console.log('Has d3.json:', hasD3Json);
  console.log('Has d3.select:', hasD3Select);
  
  // Check for backslash-backtick sequences in the served HTML
  let escapedBT = 0;
  for (let i = 0; i < html.length - 1; i++) {
    if (html[i] === '\\' && html[i+1] === '`') {
      escapedBT++;
      if (escapedBT <= 3) {
        const line = html.substring(0, i).split('\n').length;
        console.log('  ESCAPED BT at line', line, ':', html.substring(i, i+30));
      }
    }
  }
  console.log('Total escaped backtick-backtick:', escapedBT);
  
  // Also fetch API
  const apiResp = await fetch('http://127.0.0.1:4567/api/graph');
  const apiData = await apiResp.json();
  console.log('API nodes:', apiData.nodes.length, 'edges:', apiData.edges.length);
  
  process.exit(0);
}).catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});

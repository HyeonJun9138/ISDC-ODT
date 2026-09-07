const histories = new Map();

function cssColor(name, fallback) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

export function pushHistory(key, value, max = 64) {
  const list = histories.get(key) || [];
  list.push(Number(value) || 0);
  if (list.length > max) list.splice(0, list.length - max);
  histories.set(key, list);
  return list;
}

export function history(key) {
  return histories.get(key) || [];
}

export function drawSparkline(canvas, values, color = "#2d7ff9", fill = true) {
  if (!canvas || !values?.length) return;
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth || canvas.width;
  const height = canvas.clientHeight || canvas.height;
  if (canvas.width !== width * ratio || canvas.height !== height * ratio) {
    canvas.width = width * ratio; canvas.height = height * ratio;
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const min = Math.min(...values); const max = Math.max(...values); const range = max - min || 1;
  const points = values.map((v, i) => [i * width / Math.max(1, values.length - 1), height - 4 - ((v - min) / range) * (height - 10)]);
  if (fill) {
    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, `${color}30`); gradient.addColorStop(1, `${color}00`);
    ctx.beginPath(); ctx.moveTo(points[0][0], height); points.forEach(([x,y]) => ctx.lineTo(x,y)); ctx.lineTo(points.at(-1)[0], height); ctx.closePath(); ctx.fillStyle = gradient; ctx.fill();
  }
  ctx.beginPath(); points.forEach(([x,y], i) => i ? ctx.lineTo(x,y) : ctx.moveTo(x,y));
  ctx.strokeStyle = color; ctx.lineWidth = 1.8; ctx.lineJoin = "round"; ctx.lineCap = "round"; ctx.stroke();
}

export function drawMultiLine(canvas, series, colors = ["#2d7ff9", "#12a36d", "#f39a2d"]) {
  if (!canvas) return;
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth || canvas.width;
  const height = canvas.clientHeight || canvas.height;
  canvas.width = width * ratio; canvas.height = height * ratio;
  const ctx = canvas.getContext("2d"); ctx.scale(ratio, ratio); ctx.clearRect(0,0,width,height);
  ctx.strokeStyle = cssColor("--chart-grid", "#e2e8f0"); ctx.lineWidth = 1;
  for (let i=1;i<5;i++){ const y=i*height/5; ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(width,y); ctx.stroke(); }
  const all = series.flat(); const min=Math.min(...all); const max=Math.max(...all); const range=max-min||1;
  series.forEach((values, index) => {
    ctx.beginPath();
    values.forEach((v,i)=>{ const x=i*width/Math.max(1,values.length-1); const y=height-8-((v-min)/range)*(height-16); i?ctx.lineTo(x,y):ctx.moveTo(x,y); });
    ctx.strokeStyle=colors[index%colors.length]; ctx.lineWidth=index===0?2.4:1.6; ctx.stroke();
  });
}

export function seedWave(length = 48, base = 50, amplitude = 10, phase = 0) {
  return Array.from({length}, (_,i)=> base + Math.sin(i*.35+phase)*amplitude + Math.sin(i*.11+phase)*amplitude*.28);
}

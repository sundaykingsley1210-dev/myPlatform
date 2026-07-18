const { createCanvas } = require('canvas');
const fs = require('fs');
const path = require('path');

function generateIcon(size, outputPath) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  const r = size * 0.15;

  // Background
  ctx.fillStyle = '#0a0e27';
  ctx.beginPath();
  ctx.roundRect(0, 0, size, size, r);
  ctx.fill();

  // Gradient circle
  const grad = ctx.createLinearGradient(0, 0, size, size);
  grad.addColorStop(0, '#0057ff');
  grad.addColorStop(1, '#00c6ff');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(size/2, size/2, size*0.32, 0, Math.PI*2);
  ctx.fill();

  // Letter E
  ctx.fillStyle = '#ffffff';
  ctx.font = `bold ${size*0.38}px Arial`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('E', size/2, size/2);

  // Small U below
  ctx.fillStyle = '#ffd700';
  ctx.font = `bold ${size*0.16}px Arial`;
  ctx.fillText('U', size/2, size*0.78);

  const buffer = canvas.toBuffer('image/png');
  fs.writeFileSync(outputPath, buffer);
  console.log('Generated: ' + outputPath);
}

generateIcon(192, path.join(__dirname, 'public', 'icons', 'icon-192.png'));
generateIcon(512, path.join(__dirname, 'public', 'icons', 'icon-512.png'));

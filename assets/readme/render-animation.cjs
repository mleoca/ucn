#!/usr/bin/env node
// Render the animation's existing SVG drawing code at deterministic frame times.
// Requires sharp on NODE_PATH and ffmpeg on PATH; neither is a UCN dependency.
// Usage: node assets/readme/render-animation.cjs
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const sharp = require('sharp');

const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
class Element {
    constructor(tag = 'g', attrs = {}) { this.tag = tag; this.attrs = attrs; this.children = []; this.textContent = ''; }
    setAttribute(key, value) { this.attrs[key] = value; }
    appendChild(element) { this.children.push(element); }
    addEventListener() {}
    getBoundingClientRect() { return { width: 704, height: 274 }; }
    serialize() {
        const attrs = Object.entries(this.attrs).map(([key, value]) => `${key}="${escape(value)}"`).join(' ');
        return `<${this.tag} ${attrs}>${escape(this.textContent)}${this.children.map(child => child.serialize()).join('')}</${this.tag}>`;
    }
}

async function main() {
    const fragment = fs.readFileSync(path.join(__dirname, 'ucn-connected-scope.html'), 'utf8');
    const source = fragment.match(/<script>([\s\S]*?)<\/script>/)[1];
    const svg = new Element('svg');
    const elements = new Map([['.us-network', svg]]);
    for (const name of ['links', 'trails', 'nodes', 'labels']) {
        const group = new Element('g');
        svg.appendChild(group);
        elements.set(`[data-${name}]`, group);
    }
    for (const name of ['state', 'caption', 'play']) elements.set(`[data-${name}]`, new Element());
    const root = { querySelector: selector => {
        if (!elements.has(selector)) throw new Error(`Unknown element: ${selector}`);
        return elements.get(selector);
    } };
    let nextFrame;
    vm.runInNewContext(source, {
        document: { getElementById: () => root, createElementNS: (_, tag) => new Element(tag) },
        matchMedia: () => ({ matches: false, addEventListener() {} }),
        ResizeObserver: class { observe() {} },
        requestAnimationFrame: callback => { nextFrame = callback; return 1; },
        cancelAnimationFrame() {}
    });

    const palette = {
        '--background': '#181818', '--foreground': '#ffffff', '--muted-foreground': '#a0a0a0', '--border': '#343434',
        '--viz-series-1': '#83c3ff', '--viz-series-2': '#f59a56', '--viz-series-3': '#74d58b',
        '--viz-series-4': '#f08fc0', '--viz-series-5': '#aa91ef'
    };
    const styles = fragment.match(/<style>([\s\S]*?)<\/style>/)[1]
        .replaceAll('#ucn-scope ', '')
        .replace(/var\((--[a-z0-9-]+)\)/g, (_, name) => {
            if (!(name in palette)) throw new Error(`Unknown color: ${name}`);
            return palette[name];
        });
    const legend = [
        ['Functions', 16, '<circle cx="5" cy="0" r="4" class="us-function"/>'],
        ['Types', 117, '<path d="M5 -5 10 0 5 5 0 0Z" class="us-type"/>'],
        ['Modules', 190, '<rect x="1" y="-4" width="8" height="8" rx="1" class="us-module"/>'],
        ['Tests', 285, '<path d="M5 -5 10 4 0 4Z" class="us-test"/>'],
        ['Unverified', 355, '<path d="M0 0H12" class="us-uncertain-line"/><circle cx="16" cy="0" r="3" class="us-unknown"/>']
    ].map(([label, x, mark]) => `<g transform="translate(${x},324)">${mark}<text x="${label === 'Unverified' ? 25 : 17}" y="4" font-size="12">${label}</text></g>`).join('');
    const frameDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-readme-animation-'));
    try {
        for (let frame = 0; frame < 170; frame++) {
            nextFrame(frame * 50);
            const image = `<svg xmlns="http://www.w3.org/2000/svg" width="736" height="400" viewBox="0 0 736 400">
<style>${styles}</style><rect width="736" height="400" fill="#181818"/>
<g font-family="Arial, sans-serif" font-size="14" fill="#ffffff">
<text x="16" y="34" font-size="20">UCN</text><text x="73" y="34" fill="#a0a0a0">A symbol. Its reach.</text>
<text x="720" y="34" font-size="12" text-anchor="end">${escape(elements.get('[data-state]').textContent)}</text>
<g transform="translate(16,44)">${svg.children.map(child => child.serialize()).join('')}</g>
${legend}<text x="16" y="361">${escape(elements.get('[data-caption]').textContent)}</text>
<text x="16" y="387" font-size="12" fill="#a0a0a0">Conceptual graph · schematic timing</text>
</g></svg>`;
            // Rasterize the vector drawing at 3x for sharp text on HiDPI screens.
            await sharp(Buffer.from(image), { density: 216 }).png().toFile(path.join(frameDir, `${String(frame).padStart(3, '0')}.png`));
        }
        const output = path.join(__dirname, 'ucn-connected-scope.gif');
        execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-framerate', '20', '-i', path.join(frameDir, '%03d.png'),
            '-filter_complex', '[0:v]split[a][b];[a]palettegen=max_colors=256:stats_mode=full[p];[b][p]paletteuse=dither=none:diff_mode=rectangle',
            '-loop', '0', output]);
        // A completed frame also serves as an accessible static alternative.
        fs.copyFileSync(path.join(frameDir, '140.png'), path.join(__dirname, 'ucn-connected-scope.png'));
        console.log(`${output}: ${fs.statSync(output).size} bytes, 170 frames, 8.5 seconds, continuous loop`);
    } finally {
        fs.rmSync(frameDir, { recursive: true, force: true });
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

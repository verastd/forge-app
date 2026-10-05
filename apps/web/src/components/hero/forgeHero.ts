/**
 * The home page's animated hero: a WebGL2 fullscreen fragment shader of the
 * FORGE parcel grid seen in perspective, where agents (cyan) walk the streets
 * to a free lot and forge it (molten amber, embers rising), and the lot cools
 * to verified (a cyan rim). A click on the grid strikes that lot at once, with
 * a shockwave and a shake, and the nearest free agent runs to it. The camera
 * drifts and leans with the pointer.
 *
 * Ported from the "Forge Hero" design component (Forge Hero.dc.html): the same
 * shader, simulation and numbers, without the component runtime. Entities are
 * simulated on the CPU and uploaded as small uniform arrays every frame.
 *
 * Background only: the page's own copy sits over it. It draws one frame at
 * once (pre-warmed, so the first frame is already alive), runs only while on
 * screen and the tab is visible, and with reduced motion draws a still frame
 * and leaves it. `onState` reports 'ready' after the first frame, or
 * 'unsupported' (no WebGL2, or the shader failed), when the page shows its
 * gradient instead.
 */

export interface ForgeHeroOptions {
  /** Simulation speed, 0.2–2.5. */
  speed?: number;
  /** How hot the forging glows, 0.3–1.8. */
  intensity?: number;
  /** Render scale on top of the device pixel ratio (capped at 1.5), 0.4–1. */
  quality?: number;
  reducedMotion?: boolean;
  onState?: (state: 'ready' | 'unsupported') => void;
}

export interface ForgeHero {
  setReducedMotion(reduced: boolean): void;
  /** Strikes the lot under a client point (a click on the hero). */
  strike(clientX: number, clientY: number): void;
  dispose(): void;
}

const VS = `#version 300 es
in vec2 a; void main(){gl_Position=vec4(a,0.,1.);}`;

const FS = `#version 300 es
precision highp float;
out vec4 O;
uniform vec2 uRes; uniform float uT; uniform vec2 uM; uniform float uYaw; uniform float uInt;
uniform vec4 uTiles[16]; uniform vec3 uAg[8]; uniform vec4 uEmb[48]; uniform vec3 uShock[4]; uniform float uShake;
const vec3 BG=vec3(.024,.039,.071), AMB=vec3(.984,.749,.141), CYN=vec3(.133,.827,.933), SLATE=vec3(.082,.115,.19), ROAD=vec3(.03,.045,.08);
float h21(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}
float vn(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(h21(i),h21(i+vec2(1,0)),f.x),mix(h21(i+vec2(0,1)),h21(i+1.),f.x),f.y);}
float fbm(vec2 p){float a=.5,s=0.;mat2 m=mat2(.8,.6,-.6,.8);for(int i=0;i<4;i++){s+=a*vn(p);p=m*p*2.03;a*=.5;}return s;}
float sdBox(vec2 p,vec2 b){vec2 d=abs(p)-b;return length(max(d,0.))+min(max(d.x,d.y),0.);}
void main(){
  vec2 uv=(gl_FragCoord.xy-.5*uRes)/uRes.y;
  uv+=vec2(sin(uT*61.),cos(uT*53.))*uShake*.012;
  float hor=.38+uM.y*.025;
  vec3 ro=vec3(0.,2.2,0.);
  vec3 rd=normalize(vec3(uv.x,uv.y-hor,1.));
  float ca=cos(uYaw),sa=sin(uYaw); mat2 R=mat2(ca,-sa,sa,ca);
  vec3 col=BG;
  if(rd.y<0.){
    float t=-ro.y/rd.y; vec3 p=ro+rd*t;
    vec2 q=R*(p.xz-vec2(0.,5.))/1.2;
    vec2 id=floor(q), f=fract(q)-.5;
    float aa=fwidth(q.x)*.8+.002;
    float dB=sdBox(f,vec2(.36))-.055;
    float inB=smoothstep(aa,-aa,dB);
    float hv=h21(id);
    vec3 blk=SLATE*(.7+.6*hv)*(.82+.3*(f.y+.5));
    blk+=vec3(.02,.03,.05)*vn(q*9.);
    col=mix(ROAD,blk,inB);
    col+=vec3(.16,.21,.32)*smoothstep(aa*1.6+.004,0.,abs(dB))*.55;
    float gl=smoothstep(aa*1.4,0.,abs(abs(f.x)-.5))+smoothstep(aa*1.4,0.,abs(abs(f.y)-.5));
    col+=vec3(.07,.1,.17)*gl*.5;
    for(int i=0;i<16;i++){
      vec4 T=uTiles[i]; if(T.z+T.w<.001) continue;
      vec2 rel=q-(T.xy+.5); float dc=length(rel);
      bool me=all(equal(id,T.xy));
      float heat=clamp(T.z*uInt,0.,1.);
      if(me){
        float n=fbm(rel*4.5+vec2(uT*.7,-uT*.5));
        float core=smoothstep(.5,0.,dc+n*.28-heat*.42);
        vec3 molten=mix(AMB*.95,vec3(1.,.96,.82),core*core);
        molten=mix(AMB*.3,molten,smoothstep(0.,.6,core+heat*.3));
        float cracks=smoothstep(.45,.55,fbm(rel*9.+n*2.))*heat;
        molten+=AMB*cracks*.6;
        col=mix(col,molten,inB*smoothstep(0.,.2,heat)*clamp(core*1.6+heat*.7,0.,1.));
        col+=CYN*T.w*(smoothstep(aa*2.+.016,0.,abs(dB+.035))*.95+inB*.07);
        col+=CYN*T.w*inB*.12*smoothstep(.6,.4,fbm(rel*6.+uT*.1));
      }
      col+=AMB*heat*heat*exp(-dc*2.4)*.4*(me?0.:1.);
      col+=CYN*T.w*exp(-dc*3.2)*.07;
    }
    for(int i=0;i<8;i++){
      vec3 A=uAg[i]; vec2 rel=q-A.xy; float d=length(rel);
      col+=CYN*(smoothstep(.07,.015,d)*1.3+exp(-d*7.)*.22);
      float age=fract(A.z); float r=age*.55;
      col+=CYN*exp(-abs(d-r)*28.)*exp(-age*3.5)*.55*smoothstep(0.,.05,age);
    }
    for(int i=0;i<4;i++){
      vec3 S=uShock[i]; if(S.z<=0.) continue;
      float d=length(q-S.xy); float r=S.z*2.6; float w=.09+S.z*.08;
      float ring=exp(-pow((d-r)/w,2.))*exp(-S.z*1.6);
      col+=mix(AMB,CYN,smoothstep(.4,1.4,S.z))*ring*1.2;
      col+=AMB*exp(-d*3.)*exp(-S.z*7.)*1.5;
    }
    float fog=exp(-t*.055);
    col=mix(BG,col,fog);
  }
  float hz=exp(-abs(rd.y)*22.)*(.5+.5*fbm(vec2(uv.x*5.,uT*.08)));
  col+=AMB*hz*.07*uInt;
  col+=vec3(.05,.08,.14)*exp(-max(rd.y,0.)*9.)*(rd.y>0.?1.:0.);
  for(int i=0;i<48;i++){
    vec4 E=uEmb[i]; if(E.w<=0.) continue;
    vec2 d=uv-E.xy; float r2=dot(d,d)/(E.z*E.z);
    col+=mix(AMB,vec3(1.,.92,.72),E.w*E.w)*exp(-r2)*E.w*1.7;
  }
  col=col-max(col-.85,0.)*.6;
  col*=1.-smoothstep(.5,1.2,length(uv*vec2(.7,1.15)))*.5;
  col*=.97+.03*sin(gl_FragCoord.y*1.7);
  col+=(h21(gl_FragCoord.xy+fract(uT))-.5)/255.;
  O=vec4(col,1.);
}`;

const UNIFORMS = ['uRes', 'uT', 'uM', 'uYaw', 'uInt', 'uTiles', 'uAg', 'uEmb', 'uShock', 'uShake'] as const;
type UniformName = (typeof UNIFORMS)[number];

interface Tile {
  x: number;
  z: number;
  heat: number;
  ver: number;
  fade: number;
  dying?: boolean;
  strike?: number;
}

interface Agent {
  x: number;
  z: number;
  state: 'walk' | 'forge' | 'cool';
  tile: Tile | null;
  timer: number;
  phase: number;
  target: [number, number] | null;
}

interface Ember {
  qx: number;
  qz: number;
  y: number;
  vy: number;
  life: number;
  max: number;
  seed: number;
}

interface Shock {
  x: number;
  z: number;
  t0: number;
}

const MAX_TILES = 14;
const MAX_EMBERS = 48;
const AGENTS = 7;

export function createForgeHero(canvas: HTMLCanvasElement, options: ForgeHeroOptions = {}): ForgeHero {
  const speed = options.speed ?? 1;
  const intensity = options.intensity ?? 1;
  const quality = options.quality ?? 0.85;
  let reducedMotion = options.reducedMotion ?? false;

  const unsupported = (): ForgeHero => {
    options.onState?.('unsupported');
    return { setReducedMotion: () => undefined, strike: () => undefined, dispose: () => undefined };
  };

  const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, premultipliedAlpha: false });
  if (!gl) return unsupported();
  const compile = (type: number, source: string): WebGLShader | null => {
    const shader = gl.createShader(type);
    if (!shader) return null;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error('forge hero:', gl.getShaderInfoLog(shader));
      return null;
    }
    return shader;
  };
  const vs = compile(gl.VERTEX_SHADER, VS);
  const fs = compile(gl.FRAGMENT_SHADER, FS);
  const program = gl.createProgram();
  if (!vs || !fs || !program) return unsupported();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error('forge hero:', gl.getProgramInfoLog(program));
    return unsupported();
  }
  gl.useProgram(program);
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const position = gl.getAttribLocation(program, 'a');
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
  const U = Object.fromEntries(UNIFORMS.map((name) => [name, gl.getUniformLocation(program, name)])) as Record<
    UniformName,
    WebGLUniformLocation | null
  >;

  // ---------- simulation ----------
  const mouse: [number, number] = [0, 0];
  let target: [number, number] = [0, 0];
  let t = 37;
  let yaw = 0;
  let shake = 0;
  const tiles: Tile[] = [];
  const agents: Agent[] = [];
  const embers: Ember[] = [];
  let shocks: Shock[] = [];
  const tileBuf = new Float32Array(64);
  const agentBuf = new Float32Array(24);
  const emberBuf = new Float32Array(192);
  const shockBuf = new Float32Array(12);

  /** Grid space (q) under a screen uv, or null above the horizon. */
  const uvToQ = (ux: number, uy: number, atYaw?: number): [number, number] | null => {
    const hor = 0.38 + mouse[1] * 0.025;
    const ry = uy - hor;
    if (ry >= -0.02) return null;
    const dist = 2.2 / -ry;
    const x = ux * dist;
    const z = dist - 5;
    if (atYaw === undefined) return [x / 1.2, z / 1.2];
    const ca = Math.cos(atYaw);
    const sa = Math.sin(atYaw);
    return [(ca * x + sa * z) / 1.2, (-sa * x + ca * z) / 1.2];
  };
  const qToUv = (qx: number, qz: number, y: number): [number, number] | null => {
    const ca = Math.cos(yaw);
    const sa = Math.sin(yaw);
    const x = (ca * qx - sa * qz) * 1.2;
    const z = (sa * qx + ca * qz) * 1.2 + 5;
    if (z < 0.3) return null;
    return [x / z, (y - 2.2) / z + 0.38];
  };
  const randTile = (): [number, number] => {
    for (let k = 0; k < 20; k++) {
      const q = uvToQ(-0.75 + Math.random() * 1.5, -0.46 + Math.random() * 0.68);
      if (q) return [Math.floor(q[0]), Math.floor(q[1])];
    }
    return [0, 4];
  };
  const pushTile = (tile: Tile): void => {
    tiles.push(tile);
    if (tiles.length > MAX_TILES) tiles[0]!.dying = true;
  };

  for (let i = 0; i < AGENTS; i++) {
    const q = randTile();
    agents.push({ x: q[0], z: q[1], state: 'walk', tile: null, timer: 0, phase: Math.random(), target: null });
  }

  const step = (rawDt: number): void => {
    const dt = rawDt * speed;
    t += dt;
    for (const a of agents) {
      a.phase += dt * 0.55;
      if (a.state === 'walk') {
        if (!a.target) {
          let q: [number, number];
          let tries = 0;
          do {
            q = randTile();
            tries++;
          } while (
            tries < 10 &&
            (tiles.some((tile) => tile.x === q[0] && tile.z === q[1]) ||
              agents.some((o) => o.target && o.target[0] === q[0] && o.target[1] === q[1]))
          );
          a.target = q;
        }
        const v = 1.1 * dt;
        if (Math.abs(a.x - a.target[0]) > v) a.x += Math.sign(a.target[0] - a.x) * v;
        else {
          a.x = a.target[0];
          if (Math.abs(a.z - a.target[1]) > v) a.z += Math.sign(a.target[1] - a.z) * v;
          else {
            a.z = a.target[1];
            a.state = 'forge';
            a.timer = 0;
            a.tile = { x: a.target[0], z: a.target[1], heat: 0, ver: 0, fade: 1 };
            pushTile(a.tile);
          }
        }
      } else if (a.state === 'forge' && a.tile) {
        a.timer += dt;
        const k = a.timer / 4.2;
        a.tile.heat = k < 1 ? Math.min(1, k * k * 1.1) : 1;
        if (a.timer > 4.2) {
          a.state = 'cool';
          a.timer = 0;
        }
      } else if (a.state === 'cool' && a.tile) {
        a.timer += dt;
        a.tile.heat = Math.max(0, 1 - a.timer / 2.6);
        a.tile.ver = Math.min(1, a.timer / 1.4);
        if (a.timer > 3) {
          a.state = 'walk';
          a.target = null;
          a.tile = null;
        }
      }
    }
    for (const tile of tiles) {
      if (tile.strike !== undefined && !agents.some((a) => a.tile === tile)) {
        const k = t - tile.strike;
        tile.heat = Math.max(0, 1 - k / 3.5);
        tile.ver = Math.min(1, Math.max(0, (k - 2) / 1.5));
        if (k > 6) tile.strike = undefined;
      }
    }
    shake *= Math.exp(-dt * 6);
    for (let i = tiles.length - 1; i >= 0; i--) {
      const tile = tiles[i]!;
      if (tile.dying) {
        tile.fade -= dt * 0.5;
        if (tile.fade <= 0) tiles.splice(i, 1);
      }
    }
    for (const tile of tiles) {
      if (tile.heat > 0.3 && embers.length < MAX_EMBERS && Math.random() < dt * tile.heat * 14) {
        embers.push({
          qx: tile.x + 0.2 + Math.random() * 0.6,
          qz: tile.z + 0.2 + Math.random() * 0.6,
          y: 0.02,
          vy: 0.5 + Math.random() * 0.9,
          life: 0,
          max: 1.2 + Math.random() * 1.2,
          seed: Math.random() * 9,
        });
      }
    }
    for (let i = embers.length - 1; i >= 0; i--) {
      const e = embers[i]!;
      e.life += dt;
      e.y += e.vy * dt;
      e.qx += Math.sin(t * 2 + e.seed) * dt * 0.25;
      e.qz += Math.cos(t * 1.6 + e.seed * 2) * dt * 0.2;
      if (e.life > e.max) embers.splice(i, 1);
    }
  };

  // Pre-warm about eight seconds, so the first frame is already alive.
  for (let i = 0; i < 240; i++) step(1 / 30);

  // ---------- drawing ----------
  const resize = (): void => {
    const scale = Math.min(window.devicePixelRatio || 1, 1.5) * quality;
    const width = Math.max(1, (canvas.clientWidth * scale) | 0);
    const height = Math.max(1, (canvas.clientHeight * scale) | 0);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    gl.viewport(0, 0, canvas.width, canvas.height);
  };

  const draw = (): void => {
    if (canvas.width < 4) return;
    yaw = 0.78 + mouse[0] * 0.11 + Math.sin(t * 0.07) * 0.02;
    tileBuf.fill(0);
    tiles.slice(0, 16).forEach((tile, i) => {
      tileBuf[i * 4] = tile.x;
      tileBuf[i * 4 + 1] = tile.z;
      tileBuf[i * 4 + 2] = tile.heat * tile.fade;
      tileBuf[i * 4 + 3] = tile.ver * tile.fade;
    });
    agentBuf.fill(0);
    agents.forEach((a, i) => {
      agentBuf[i * 3] = a.x;
      agentBuf[i * 3 + 1] = a.z;
      agentBuf[i * 3 + 2] = a.phase;
    });
    emberBuf.fill(0);
    embers.forEach((e, i) => {
      const uv = qToUv(e.qx, e.qz, e.y);
      if (!uv) return;
      const k = e.life / e.max;
      const glow = Math.sin(k * Math.PI);
      emberBuf[i * 4] = uv[0];
      emberBuf[i * 4 + 1] = uv[1];
      emberBuf[i * 4 + 2] = 0.004 + (1 - k) * 0.004;
      emberBuf[i * 4 + 3] = glow * glow * (1 - k * 0.4);
    });
    shockBuf.fill(0);
    shocks = shocks.filter((s) => t - s.t0 < 2.5);
    shocks.forEach((s, i) => {
      shockBuf[i * 3] = s.x;
      shockBuf[i * 3 + 1] = s.z;
      shockBuf[i * 3 + 2] = t - s.t0;
    });
    gl.uniform2f(U.uRes, canvas.width, canvas.height);
    gl.uniform1f(U.uT, t);
    gl.uniform2f(U.uM, mouse[0], mouse[1]);
    gl.uniform1f(U.uYaw, yaw);
    gl.uniform1f(U.uInt, intensity);
    gl.uniform3fv(U.uShock, shockBuf);
    gl.uniform1f(U.uShake, shake);
    gl.uniform4fv(U.uTiles, tileBuf);
    gl.uniform3fv(U.uAg, agentBuf);
    gl.uniform4fv(U.uEmb, emberBuf);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };

  // ---------- loop: only while on screen, visible and moving ----------
  let raf = 0;
  let last = performance.now();
  let onScreen = true;
  let disposed = false;
  let reported = false;

  const frame = (now: number): void => {
    raf = 0;
    if (disposed) return;
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    mouse[0] += (target[0] - mouse[0]) * 0.04;
    mouse[1] += (target[1] - mouse[1]) * 0.04;
    step(dt);
    draw();
    schedule();
  };
  const schedule = (): void => {
    if (raf || disposed || reducedMotion || !onScreen || document.hidden) return;
    last = performance.now();
    raf = requestAnimationFrame(frame);
  };
  const stop = (): void => {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  };

  const onMove = (event: PointerEvent): void => {
    const r = canvas.getBoundingClientRect();
    target = [((event.clientX - r.left) / r.width - 0.5) * 2, -((event.clientY - r.top) / r.height - 0.5) * 2];
  };
  const onVisibility = (): void => (document.hidden ? stop() : schedule());
  window.addEventListener('pointermove', onMove, { passive: true });
  document.addEventListener('visibilitychange', onVisibility);
  const resizeObserver = new ResizeObserver(() => {
    resize();
    if (!raf) draw();
  });
  resizeObserver.observe(canvas);
  const intersection = new IntersectionObserver(([entry]) => {
    onScreen = entry?.isIntersecting ?? true;
    if (onScreen) schedule();
    else stop();
  });
  intersection.observe(canvas);

  resize();
  draw();
  if (!reported) {
    reported = true;
    options.onState?.('ready');
  }
  schedule();

  return {
    setReducedMotion(reduced) {
      reducedMotion = reduced;
      if (reduced) stop();
      else schedule();
    },
    strike(clientX, clientY) {
      const r = canvas.getBoundingClientRect();
      const ux = ((clientX - r.left) / r.width - 0.5) * (r.width / r.height);
      const uy = -((clientY - r.top) / r.height - 0.5);
      const q = uvToQ(ux, uy, yaw);
      if (!q) return;
      const tx = Math.floor(q[0]);
      const tz = Math.floor(q[1]);
      let tile = tiles.find((x) => x.x === tx && x.z === tz);
      if (!tile) {
        tile = { x: tx, z: tz, heat: 0, ver: 0, fade: 1 };
        pushTile(tile);
      }
      tile.dying = false;
      tile.fade = 1;
      tile.strike = t;
      tile.heat = 1;
      tile.ver = 0;
      for (let i = 0; i < 22 && embers.length < MAX_EMBERS; i++) {
        embers.push({
          qx: tx + 0.5 + (Math.random() - 0.5) * 0.5,
          qz: tz + 0.5 + (Math.random() - 0.5) * 0.5,
          y: 0.05,
          vy: 1.2 + Math.random() * 1.6,
          life: 0,
          max: 0.9 + Math.random(),
          seed: Math.random() * 9,
        });
      }
      shocks.push({ x: tx + 0.5, z: tz + 0.5, t0: t });
      if (shocks.length > 4) shocks.shift();
      // The nearest free agent rushes over to re-forge it.
      let best: Agent | null = null;
      let bestDistance = Infinity;
      for (const a of agents) {
        if (a.state !== 'walk') continue;
        const d = Math.hypot(a.x - tx, a.z - tz);
        if (d < bestDistance) {
          bestDistance = d;
          best = a;
        }
      }
      if (best) best.target = [tx, tz];
      shake = reducedMotion ? 0 : 1;
      if (reducedMotion) {
        // No animation: show the struck lot hot, as one still frame.
        draw();
      }
    },
    dispose() {
      disposed = true;
      stop();
      window.removeEventListener('pointermove', onMove);
      document.removeEventListener('visibilitychange', onVisibility);
      resizeObserver.disconnect();
      intersection.disconnect();
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    },
  };
}

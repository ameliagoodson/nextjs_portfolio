import * as THREE from "three";
import { KawaseBlurPassGen } from "three-kawase-blur";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import {
  FullScreenQuad,
  Pass,
} from "three/examples/jsm/postprocessing/Pass.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";

const KawaseBlurPass = KawaseBlurPassGen({
  THREE,
  EffectComposer,
  Pass,
  FullScreenQuad,
});

const simulationVertexShader = `varying vec2 vUv;

void main() {
  vUv = uv;

  gl_Position = vec4(position, 1.0);
}
`;

const simulationFragmentShader = `uniform sampler2D uParticleState;
uniform sampler2D uInitialState;
uniform vec2 uMouse;
uniform vec2 uMouseVelocity;
uniform float uDeltaTime;
uniform float uDamping;
uniform float uInteractionRadius;
uniform float uAspectRatio;
uniform float uPushStrength;

varying vec2 vUv;

const float springConstant = 11.0;
const float damping = 6.0;
const float maxVelocity = 1.7;

void main() {
  vec4 particleData = texture2D(uParticleState, vUv);
  vec2 pos = particleData.rg;
  vec2 velocity = particleData.ba;
  vec2 originalPos = texture2D(uInitialState, vUv).rg;
  float distToOriginal = distance(pos.xy, originalPos.xy);

  vec2 mousePos = vec2(uMouse.x, uMouse.y * uAspectRatio * 2.0);
  vec2 dirToMouse = vec2(pos.x, pos.y * uAspectRatio * 2.0) - mousePos;
  float distToMouse = length(dirToMouse);

  float mouseSpeed = length(uMouseVelocity);

  vec2 totalForce = vec2(0.0);
  if(distToMouse < uInteractionRadius) {
    float falloff = smoothstep(0.0, 1.0, 1.0 - distToMouse/uInteractionRadius);

    vec2 pushForce = vec2(0.0);
    if(mouseSpeed > 0.001) {
      pushForce = normalize(uMouseVelocity) * mouseSpeed * uPushStrength * falloff;
    }

    totalForce = pushForce;
  }

  vec2 springForce = (originalPos - pos) * springConstant;

  vec2 acceleration = totalForce + springForce;

  float dampingFactor = exp(-damping * uDeltaTime);
  vec2 newVelocity = velocity * dampingFactor + acceleration * uDeltaTime;

  if(length(newVelocity) > maxVelocity) {
    newVelocity = normalize(newVelocity) * maxVelocity;
  }

  vec2 newPos = pos + newVelocity * uDeltaTime;

  if (distToOriginal < 0.05 && length(newVelocity) < 0.05) {
    newPos = mix(pos, originalPos, 0.1);
    newVelocity = vec2(0.0);
  }

  gl_FragColor = vec4(newPos, newVelocity);
}
`;

const discVertexShader = `uniform sampler2D uPositions;
uniform sampler2D uInitialState;
uniform float uTime;

const float pointSize = 8.0;

void main() {
  vec3 pos = texture2D(uPositions, position.xy).xyz;
  vec3 initialPos = texture2D(uInitialState, position.xy).xyz;

  float dist = distance(pos.xy, initialPos.xy);

  float sizeMultiplier = 1.0 + dist * 6.0;

  gl_Position = vec4(pos.xy, 0.0, 1.0);

  gl_PointSize = pointSize * sizeMultiplier;
}
`;

const discFragmentShader = `uniform sampler2D uMap;

void main() {
  vec2 uv = gl_PointCoord;

  float dist = distance(uv, vec2(0.5));

  if(dist > 0.5) {
    discard;
  }

  gl_FragColor = vec4(1.0);
}
`;

const finalVertexShader = `varying vec2 vUv;

void main() {
  vUv = uv;

  gl_Position = modelMatrix * vec4(position, 1.0);
}
`;

const finalFragmentShader = `varying vec2 vUv;
uniform sampler2D uBlurredTexture;
uniform sampler2D uMatcap;
uniform float uOpacity;
uniform float uIntroProgress;
uniform float uThreshold;
uniform float uCutoff;

const float matcapRotation = 3.1459;
const float strength = 7.0;
const float offsetStrength = 0.008;

float sampleWithThreshold(vec2 uv) {
  float value = texture2D(uBlurredTexture, uv).r;
  return value > uThreshold ? value : 0.0;
}

const int STEPS = 15;

void main() {
  float normalSample = sampleWithThreshold(vUv);

  if (normalSample <= uCutoff || uOpacity <= 0.0) {
    discard;
    return;
  }

  float stepSize = offsetStrength / float(STEPS);

  float sumDx = 0.0;
  float sumDy = 0.0;
  float weight = 0.0;
  float totalWeight = 0.0;

  for (int i = 1; i <= STEPS; i++) {
    float offset = float(i) * stepSize;
    weight = 1.0 - float(i) / float(STEPS);

    float left = sampleWithThreshold(vec2(vUv.x - offset, vUv.y));
    float right = sampleWithThreshold(vec2(vUv.x + offset, vUv.y));
    float top = sampleWithThreshold(vec2(vUv.x, vUv.y - offset));
    float bottom = sampleWithThreshold(vec2(vUv.x, vUv.y + offset));

    sumDx += (right - left) * weight;
    sumDy += (bottom - top) * weight;
    totalWeight += weight;
  }

  float dx = totalWeight > 0.0 ? sumDx / totalWeight : 0.0;
  float dy = totalWeight > 0.0 ? sumDy / totalWeight : 0.0;

  vec3 normal = normalize(vec3(-dx * strength, -dy * strength, 1.0));

  vec2 matcapUV = normal.xy * 0.5 + 0.5;

  float rotationOffset = 0.0;
  if (uIntroProgress > 0.2) {
    float rotationMask = clamp(vUv.x + 0.55 - uIntroProgress, 0.0, 1.0) * 2.0;
    rotationOffset = (1.0 - uIntroProgress) * 5.0 * rotationMask;
  }

  float s = sin(matcapRotation + rotationOffset);
  float c = cos(matcapRotation + rotationOffset);
  vec2 matcapCenter = vec2(0.5, 0.5);
  vec2 rotatedUV = matcapCenter + mat2(c, -s, s, c) * (matcapUV - matcapCenter);

  vec3 matcapColor = texture2D(uMatcap, rotatedUV).rgb;

  vec3 color = matcapColor;

  float bloomBrightness = 65.0 * uIntroProgress;
  float bloomMask = clamp(vUv.x + 0.2 - uIntroProgress, 0.0, 1.0);
  float bloomFactor = bloomBrightness * bloomMask * bloomMask;

  gl_FragColor = vec4(color * 0.95 + vec3(5.0, 5.0, 12.0) * bloomFactor, normalSample * uOpacity);
}
`;

function extractParticlesFromTexture(
  texture: THREE.Texture,
  particleCount: number
): Float32Array {
  const data = new Float32Array(particleCount * 4);
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");

  if (!ctx) throw new Error("Could not get 2d context");

  const img = texture.image as HTMLImageElement;
  canvas.width = img.width;
  canvas.height = img.height;
  ctx.drawImage(img, 0, 0);

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const threshold = 200;
  let count = 0;

  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x++) {
      const index = (y * canvas.width + x) * 4;
      if (imageData[index] > threshold && count < particleCount) {
        const i = count * 4;
        data[i + 0] = (x / canvas.width) * 2 - 1;
        data[i + 1] = -((y / canvas.height) * 2 - 1);
        data[i + 2] = 0;
        data[i + 3] = 0;
        count++;
      }
    }
  }

  return data;
}

export class ChromeTextScene {
  private renderer: THREE.WebGLRenderer;
  private canvas: HTMLCanvasElement;
  private getViewportDimensions: () => { width: number; height: number };

  private OFFSCREEN_WIDTH: number;
  private OFFSCREEN_HEIGHT: number;
  private SCALE = 2.58;
  private GRID_WIDTH: number;
  private GRID_HEIGHT: number;
  private PARTICLE_COUNT: number;
  private BLUR_KERNELS: number[];

  private isTouchDevice: boolean;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private mouse = new THREE.Vector2();
  private mouseVelocity = new THREE.Vector2();
  private lastMouse = new THREE.Vector2();
  private lastMoveTime = performance.now();
  private lastFrameTime?: number;
  private animationId?: number;

  private params!: {
    pushStrength: number;
    interactionRadius: number;
    velocityScale: number;
    maxVelocity: number;
    velocitySmoothing: number;
    threshold: number;
    cutoff: number;
    strength: number;
    pointSize: number;
  };

  private initialStateTexture!: THREE.DataTexture;
  private simulationRT1!: THREE.WebGLRenderTarget;
  private simulationRT2!: THREE.WebGLRenderTarget;
  private simulationMaterial!: THREE.ShaderMaterial;
  private offscreenScene!: THREE.Scene;
  private offscreenCamera!: THREE.OrthographicCamera;
  private offscreenPoints!: THREE.Points;
  private discMaterial!: THREE.ShaderMaterial;
  private composer!: InstanceType<typeof EffectComposer>;
  private blurPass: unknown;
  private finalMaterial!: THREE.ShaderMaterial;
  private fullscreenQuad!: THREE.Mesh;

  // Cached objects for the per-frame simulation pass — avoids GC pressure
  private _simScene!: THREE.Scene;
  private _simCamera!: THREE.OrthographicCamera;
  private _simQuad!: THREE.Mesh;

  private mouseMoveHandler: (
    e: MouseEvent | { clientX: number; clientY: number }
  ) => void;
  private touchMoveHandler: (e: TouchEvent) => void;
  private touchStartHandler: (e: TouchEvent) => void;
  private touchInScrollZone = false;
  private _lastResizeWidth: number;
  private _guardedResizeHandler: () => void;

  constructor(
    renderer: THREE.WebGLRenderer,
    canvas: HTMLCanvasElement,
    getViewportDimensions?: () => { width: number; height: number }
  ) {
    this.renderer = renderer;
    this.canvas = canvas;
    this.getViewportDimensions =
      getViewportDimensions ||
      (() => ({ width: window.innerWidth, height: window.innerHeight }));

    this.isTouchDevice = "ontouchstart" in window;
    this.OFFSCREEN_WIDTH = 1340 * 2;
    this.OFFSCREEN_HEIGHT = 584 * 2;
    this.GRID_WIDTH = 256;
    this.GRID_HEIGHT = 128;
    this.BLUR_KERNELS = [0, 1, 2, 3, 4, 5, 6];
    this.PARTICLE_COUNT = this.GRID_WIDTH * this.GRID_HEIGHT;

    this.scene = new THREE.Scene();

    this.camera = new THREE.PerspectiveCamera(
      75,
      window.innerWidth / window.innerHeight,
      0.1,
      1000
    );
    this.camera.position.z = 2;
    this.scene.background = null;

    this.mouseMoveHandler = this.handleMouseMove.bind(this);
    this.touchMoveHandler = this.handleTouchMove.bind(this);
    this.touchStartHandler = this.handleTouchStart.bind(this);

    window.addEventListener("mousemove", this.mouseMoveHandler);
    this.canvas.addEventListener("touchstart", this.touchStartHandler, {
      passive: true,
    });
    this.canvas.addEventListener("touchmove", this.touchMoveHandler, {
      passive: false,
    });

    this._lastResizeWidth = window.innerWidth;
    this._guardedResizeHandler = () => {
      if (window.innerWidth !== this._lastResizeWidth) {
        this._lastResizeWidth = window.innerWidth;
        this.onWindowResize();
      }
    };
    window.addEventListener("resize", this._guardedResizeHandler);

    this.init();
  }

  private handleTouchStart(event: TouchEvent) {
    if (event.touches && event.touches.length > 0) {
      const touch = event.touches[0];
      const rect = this.canvas.getBoundingClientRect();
      const touchY = touch.clientY - rect.top;
      this.touchInScrollZone = touchY > rect.height * 0.75;
      if (!this.touchInScrollZone) {
        this.handleMouseMove({
          clientX: touch.clientX,
          clientY: touch.clientY,
        });
      }
    }
  }

  private handleTouchMove(event: TouchEvent) {
    if (event.touches && event.touches.length > 0) {
      if (this.touchInScrollZone) return;
      event.preventDefault();
      const touch = event.touches[0];
      this.handleMouseMove({ clientX: touch.clientX, clientY: touch.clientY });
    }
  }

  private handleMouseMove(event: { clientX: number; clientY: number }) {
    const now = performance.now();
    const dt = Math.max(now - this.lastMoveTime, 16);

    this.lastMouse.copy(this.mouse);

    const cw = this.canvas.clientWidth || window.innerWidth;
    const ch = this.canvas.clientHeight || window.innerHeight;
    this.mouse.x = (event.clientX / cw) * 2 - 1;
    this.mouse.y = -(event.clientY / ch) * 2 + 1;

    const deltaX = this.mouse.x - this.lastMouse.x;
    const deltaY = this.mouse.y - this.lastMouse.y;

    const velocityScale = this.params?.velocityScale || 150;
    const rawVelX = (deltaX / dt) * velocityScale;
    const rawVelY = (deltaY / dt) * velocityScale;

    const velocitySmoothing = this.params?.velocitySmoothing || 0.5;
    this.mouseVelocity.x =
      this.mouseVelocity.x * velocitySmoothing +
      rawVelX * (1 - velocitySmoothing);
    this.mouseVelocity.y =
      this.mouseVelocity.y * velocitySmoothing +
      rawVelY * (1 - velocitySmoothing);

    const maxVelocity = this.params?.maxVelocity || 10.0;
    const velLength = Math.sqrt(
      this.mouseVelocity.x * this.mouseVelocity.x +
        this.mouseVelocity.y * this.mouseVelocity.y
    );
    if (velLength > maxVelocity) {
      this.mouseVelocity.x = (this.mouseVelocity.x / velLength) * maxVelocity;
      this.mouseVelocity.y = (this.mouseVelocity.y / velLength) * maxVelocity;
    }

    this.lastMoveTime = now;
  }

  private rebuildDiscShader() {
    if (!this.discMaterial) return;

    this.discMaterial.vertexShader = `uniform sampler2D uPositions;
uniform sampler2D uInitialState;
uniform float uTime;

const float pointSize = ${this.params.pointSize.toFixed(1)};

void main() {
  vec3 pos = texture2D(uPositions, position.xy).xyz;
  vec3 initialPos = texture2D(uInitialState, position.xy).xyz;

  float dist = distance(pos.xy, initialPos.xy);
  float sizeMultiplier = 1.0 + dist * 6.0;

  gl_Position = vec4(pos.xy, 0.0, 1.0);
  gl_PointSize = pointSize * sizeMultiplier;
}`;
    this.discMaterial.needsUpdate = true;
  }

  private async init() {
    this.params = {
      pushStrength: 150,
      interactionRadius: 0.04,
      velocityScale: 150,
      maxVelocity: 10,
      velocitySmoothing: 0.05,
      threshold: 0.36,
      cutoff: 0.6,
      strength: 7.0,
      pointSize: 20.0,
    };

    const loader = new THREE.TextureLoader();

    const [positionTexture, matcapTexture] = await Promise.all([
      new Promise<THREE.Texture>((resolve) =>
        loader.load("/textures/hero-text-11-southwave.png", resolve)
      ),
      new Promise<THREE.Texture>((resolve) =>
        loader.load("/textures/matcap_512.png", resolve)
      ),
    ]);

    const particleData = extractParticlesFromTexture(
      positionTexture,
      this.PARTICLE_COUNT
    );

    this.initialStateTexture = new THREE.DataTexture(
      particleData,
      this.GRID_WIDTH,
      this.GRID_HEIGHT,
      THREE.RGBAFormat,
      THREE.FloatType
    );
    this.initialStateTexture.needsUpdate = true;

    const rtOptions = {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      format: THREE.RGBAFormat,
      type: THREE.FloatType,
    };

    this.simulationRT1 = new THREE.WebGLRenderTarget(
      this.GRID_WIDTH,
      this.GRID_HEIGHT,
      rtOptions
    );
    this.simulationRT2 = new THREE.WebGLRenderTarget(
      this.GRID_WIDTH,
      this.GRID_HEIGHT,
      rtOptions
    );

    this.initializeSimulationTargets();

    this.simulationMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uParticleState: { value: this.initialStateTexture },
        uInitialState: { value: this.initialStateTexture },
        uMouse: { value: new THREE.Vector2() },
        uMouseVelocity: { value: new THREE.Vector2() },
        uDeltaTime: { value: 0 },
        uInteractionRadius: { value: 0.04 },
        uAspectRatio: { value: this.OFFSCREEN_HEIGHT / this.OFFSCREEN_WIDTH },
        uPushStrength: { value: 150.0 },
      },
      vertexShader: simulationVertexShader,
      fragmentShader: simulationFragmentShader,
    });

    // Cache simulation pass objects so we don't allocate per frame
    this._simScene = new THREE.Scene();
    this._simCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._simQuad = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      this.simulationMaterial
    );
    this._simScene.add(this._simQuad);

    this.setupOffscreenRendering();
    this.rebuildDiscShader();
    this.setupFinalScene(matcapTexture);

    this.animate();
  }

  private initializeSimulationTargets() {
    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const quad = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.MeshBasicMaterial({ map: this.initialStateTexture })
    );
    scene.add(quad);

    this.renderer.setRenderTarget(this.simulationRT1);
    this.renderer.render(scene, camera);
    this.renderer.setRenderTarget(this.simulationRT2);
    this.renderer.render(scene, camera);
    this.renderer.setRenderTarget(null);
  }

  private setupOffscreenRendering() {
    this.offscreenScene = new THREE.Scene();
    this.offscreenCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
    this.offscreenCamera.position.z = 1;

    const positions = new Float32Array(this.PARTICLE_COUNT * 3);
    for (let i = 0; i < this.PARTICLE_COUNT; i++) {
      positions[i * 3] = (i % this.GRID_WIDTH) / this.GRID_WIDTH;
      positions[i * 3 + 1] = Math.floor(i / this.GRID_WIDTH) / this.GRID_HEIGHT;
      positions[i * 3 + 2] = 0;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(positions, 3)
    );

    this.discMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uPositions: { value: null },
        uInitialState: { value: this.initialStateTexture },
        uTime: { value: 0 },
      },
      vertexShader: discVertexShader,
      fragmentShader: discFragmentShader,
      transparent: false,
      depthTest: false,
    });

    this.offscreenPoints = new THREE.Points(geometry, this.discMaterial);
    this.offscreenPoints.scale.set(this.SCALE, this.SCALE, 1);
    this.offscreenScene.add(this.offscreenPoints);

    this.composer = new EffectComposer(this.renderer);
    this.composer.setSize(this.OFFSCREEN_WIDTH, this.OFFSCREEN_HEIGHT);
    this.composer.addPass(
      new RenderPass(this.offscreenScene, this.offscreenCamera)
    );

    this.blurPass = new KawaseBlurPass({
      renderer: this.renderer,
      kernels: this.BLUR_KERNELS,
      resolutionScale: 0.5,
    });

    this.composer.addPass(this.blurPass as Pass);
  }

  private setupFinalScene(matcapTexture: THREE.Texture) {
    this.finalMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uBlurredTexture: { value: null },
        uOpacity: { value: 1 },
        uMatcap: { value: matcapTexture },
        uIntroProgress: { value: 1.5 },
        uThreshold: { value: 0.36 },
        uCutoff: { value: 0.72 },
      },
      vertexShader: finalVertexShader,
      fragmentShader: finalFragmentShader,
      depthTest: false,
      transparent: true,
    });

    const planeHeight = 2 * (this.OFFSCREEN_HEIGHT / this.OFFSCREEN_WIDTH);
    const fsQuadGeometry = new THREE.PlaneGeometry(2, planeHeight);
    this.fullscreenQuad = new THREE.Mesh(fsQuadGeometry, this.finalMaterial);

    // Use actual viewport dimensions for scene layout — not the render buffer,
    // which is wider on portrait mobile for text quality but shouldn't affect positioning.
    const canvasWidth = window.innerWidth;
    const canvasHeight = window.innerHeight;
    const aspectRatio = canvasWidth / canvasHeight;

    let scale = Math.min(1200, canvasWidth) / canvasWidth;
    if (canvasWidth >= 768) scale *= 1.2;

    if (aspectRatio > 1) {
      if (canvasHeight < 500) scale *= 0.35;
      else if (canvasHeight < 600) scale *= 0.5;
      else if (canvasHeight < 700) scale *= 0.6;
      else if (canvasHeight < 800) scale *= 0.65;
      else if (canvasHeight < 900) scale *= 0.7;
      else if (canvasHeight < 1100) scale *= 0.85;
      else if (canvasHeight < 1200) scale *= 0.9;
    }

    const yOffset =
      aspectRatio > 1 ? 1 - 2 * 0.434 - 0.35 : 1 - 2 * 0.345 - 0.35;
    this.fullscreenQuad.position.y = yOffset;
    this.fullscreenQuad.scale.set(
      scale * this.SCALE,
      scale * this.SCALE * (canvasWidth / canvasHeight),
      1
    );

    this.scene.add(this.fullscreenQuad);
  }

  private updateParticleSimulation(deltaTime: number) {
    const quadScale = this.fullscreenQuad.scale;
    const quadPos = this.fullscreenQuad.position;

    const canvasWidth = this.canvas.clientWidth || window.innerWidth;
    const canvasHeight = this.canvas.clientHeight || window.innerHeight;
    const aspectRatio = canvasHeight / canvasWidth;
    const textureAspect = this.OFFSCREEN_HEIGHT / this.OFFSCREEN_WIDTH;

    const scale = quadScale.x / this.SCALE;
    const yOffset = quadPos.y;

    const transformedMouseX = this.mouse.x / (scale * this.SCALE);
    const transformedMouseY =
      (((this.mouse.y - yOffset) / scale) * aspectRatio) /
      (this.SCALE * textureAspect);

    const transformedMouse = new THREE.Vector2(
      transformedMouseX,
      transformedMouseY
    );

    const xVelocityScale = aspectRatio * 0.5;
    const yVelocityScale = this.isTouchDevice ? 2.5 : 1.5;

    this.simulationMaterial.uniforms.uMouse.value.copy(transformedMouse);
    this.simulationMaterial.uniforms.uMouseVelocity.value.set(
      this.mouseVelocity.x * xVelocityScale,
      this.mouseVelocity.y * yVelocityScale
    );
    this.simulationMaterial.uniforms.uDeltaTime.value = deltaTime;

    const inputTarget = this.simulationRT1;
    const outputTarget = this.simulationRT2;

    this.simulationMaterial.uniforms.uParticleState.value = inputTarget.texture;

    this.renderer.setRenderTarget(outputTarget);
    this.renderer.render(this._simScene, this._simCamera);
    this.renderer.setRenderTarget(null);

    this.simulationRT1 = outputTarget;
    this.simulationRT2 = inputTarget;

    this.discMaterial.uniforms.uPositions.value = outputTarget.texture;
  }

  private animate() {
    const now = performance.now();
    let deltaTime = (now - (this.lastFrameTime || now)) / 1000;

    if (deltaTime > 0.1) {
      deltaTime = 1 / 60;
    } else {
      deltaTime = Math.min(deltaTime, 1 / 30);
    }

    this.lastFrameTime = now;

    const timeSinceLastMove = now - this.lastMoveTime;
    if (timeSinceLastMove > 50) {
      const decay = Math.exp(-timeSinceLastMove * 0.01);
      this.mouseVelocity.x *= decay;
      this.mouseVelocity.y *= decay;
    }

    this.updateParticleSimulation(deltaTime);

    this.composer.render();

    this.finalMaterial.uniforms.uBlurredTexture.value =
      this.composer.readBuffer.texture;

    this.renderer.render(this.scene, this.camera);

    this.animationId = requestAnimationFrame(() => this.animate());
  }

  private onWindowResize() {
    const viewport = this.getViewportDimensions();
    const { width, height } = viewport;

    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();

    const aspectRatio = width / height;

    let maxSize: number;
    if (width < 768) maxSize = 900;
    else if (width < 1200) maxSize = 1100;
    else if (width < 2000) maxSize = 1400;
    else maxSize = 1100;

    let scale = Math.min(maxSize, width) / width;
    if (width >= 768) scale *= 1.2;

    if (aspectRatio > 1) {
      if (height < 500) scale *= 0.35;
      else if (height < 600) scale *= 0.5;
      else if (height < 700) scale *= 0.6;
      else if (height < 800) scale *= 0.65;
      else if (height < 900) scale *= 0.7;
      else if (height < 1100) scale *= 0.85;
      else if (height < 1200) scale *= 0.9;
    }

    const yOffset =
      aspectRatio > 1 ? 1 - 2 * 0.434 - 0.35 : 1 - 2 * 0.345 - 0.35;

    if (this.fullscreenQuad) {
      this.fullscreenQuad.position.y = yOffset;
      this.fullscreenQuad.scale.set(
        scale * this.SCALE,
        scale * this.SCALE * (width / height),
        1
      );
    }
  }

  cleanup() {
    if (this.animationId) cancelAnimationFrame(this.animationId);

    window.removeEventListener("mousemove", this.mouseMoveHandler);
    window.removeEventListener("resize", this._guardedResizeHandler);
    this.canvas.removeEventListener("touchstart", this.touchStartHandler);
    this.canvas.removeEventListener("touchmove", this.touchMoveHandler);

    this.simulationRT1?.dispose();
    this.simulationRT2?.dispose();
    this.initialStateTexture?.dispose();
    if (this.offscreenPoints) {
      this.offscreenPoints.geometry.dispose();
      (this.offscreenPoints.material as THREE.Material).dispose();
    }
    if (this.fullscreenQuad) {
      this.fullscreenQuad.geometry.dispose();
      (this.fullscreenQuad.material as THREE.Material).dispose();
    }
    this.composer?.dispose();
    this.scene.clear();
  }
}

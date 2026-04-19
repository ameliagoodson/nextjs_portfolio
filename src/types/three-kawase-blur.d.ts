declare module "three-kawase-blur" {
  import { WebGLRenderer } from "three";
  import {
    EffectComposer,
    Pass,
    FullScreenQuad,
  } from "three/examples/jsm/postprocessing/EffectComposer.js";

  interface KawaseBlurPassGenOptions {
    THREE: object;
    EffectComposer: typeof EffectComposer;
    Pass: typeof Pass;
    FullScreenQuad: typeof FullScreenQuad;
  }

  interface KawaseBlurPassOptions {
    renderer: WebGLRenderer;
    kernels?: number[];
    resolutionScale?: number;
  }

  type KawaseBlurPassConstructor = new (options: KawaseBlurPassOptions) => Pass;

  export function KawaseBlurPassGen(
    options: KawaseBlurPassGenOptions
  ): KawaseBlurPassConstructor;
}

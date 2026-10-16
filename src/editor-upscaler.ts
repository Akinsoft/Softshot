const vertexShaderSource = `#version 300 es
const vec2 corners[3] = vec2[3](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
void main() {
  gl_Position = vec4(corners[gl_VertexID], 0.0, 1.0);
}
`;

const fragmentShaderSource = `#version 300 es
precision highp float;
precision highp int;

uniform sampler2D sourceTexture;
uniform ivec2 sourceSize;
uniform vec2 outputSize;
uniform bool isVertical;
uniform bool flipOutput;

out vec4 fragmentColor;

const float PI = 3.14159265358979;
const float LOBES = 3.0;

float lanczos(float x) {
  x = abs(x);
  if (x < 1e-5) {
    return 1.0;
  }
  if (x >= LOBES) {
    return 0.0;
  }
  float px = PI * x;
  return LOBES * sin(px) * sin(px / LOBES) / (px * px);
}

vec4 fetchTap(int along, int across) {
  ivec2 texel = isVertical ? ivec2(across, along) : ivec2(along, across);
  texel = clamp(texel, ivec2(0), sourceSize - 1);
  return texelFetch(sourceTexture, texel, 0);
}

void main() {
  vec2 position = gl_FragCoord.xy;
  if (flipOutput) {
    position.y = outputSize.y - position.y;
  }

  float outputAlong = isVertical ? position.y : position.x;
  int across = int(floor(isVertical ? position.x : position.y));
  float sourceLength = float(isVertical ? sourceSize.y : sourceSize.x);
  float outputLength = isVertical ? outputSize.y : outputSize.x;
  float sourceCenter = outputAlong * sourceLength / outputLength - 0.5;
  float base = floor(sourceCenter);
  float fraction = sourceCenter - base;
  int baseIndex = int(base);

  vec4 sum = vec4(0.0);
  float weightSum = 0.0;
  for (int tap = -2; tap <= 3; tap++) {
    float weight = lanczos(fraction - float(tap));
    sum += fetchTap(baseIndex + tap, across) * weight;
    weightSum += weight;
  }

  vec4 nearA = fetchTap(baseIndex, across);
  vec4 nearB = fetchTap(baseIndex + 1, across);
  fragmentColor = clamp(sum / weightSum, min(nearA, nearB), max(nearA, nearB));
}
`;

const triangleVertexCount = 3;

interface UpscalePass {
  flipOutput: boolean;
  framebuffer: WebGLFramebuffer | null;
  isVertical: boolean;
  outputHeight: number;
  outputWidth: number;
  sourceHeight: number;
  sourceTexture: WebGLTexture;
  sourceWidth: number;
}

export class VideoUpscaler {
  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly sourceTexture: WebGLTexture;
  private readonly intermediateTexture: WebGLTexture;
  private readonly intermediateFramebuffer: WebGLFramebuffer;
  private intermediateHeight = 0;
  private readonly uniforms: {
    flipOutput: WebGLUniformLocation;
    isVertical: WebGLUniformLocation;
    outputSize: WebGLUniformLocation;
    sourceSize: WebGLUniformLocation;
    sourceTexture: WebGLUniformLocation;
  };

  readonly canvas: OffscreenCanvas;

  constructor(
    private readonly outputWidth: number,
    private readonly outputHeight: number
  ) {
    this.canvas = new OffscreenCanvas(outputWidth, outputHeight);
    const gl = this.canvas.getContext("webgl2", { alpha: false, antialias: false, preserveDrawingBuffer: true });
    if (!gl) {
      throw new Error("The upscaler needs WebGL 2, which is unavailable.");
    }

    this.gl = gl;
    this.program = createProgram(gl);
    this.uniforms = {
      flipOutput: requiredUniform(gl, this.program, "flipOutput"),
      isVertical: requiredUniform(gl, this.program, "isVertical"),
      outputSize: requiredUniform(gl, this.program, "outputSize"),
      sourceSize: requiredUniform(gl, this.program, "sourceSize"),
      sourceTexture: requiredUniform(gl, this.program, "sourceTexture")
    };
    this.sourceTexture = createTexture(gl);
    this.intermediateTexture = createTexture(gl);
    this.intermediateFramebuffer = gl.createFramebuffer();
  }

  private ensureIntermediateHeight(sourceHeight: number): void {
    if (sourceHeight === this.intermediateHeight) {
      return;
    }

    const { gl } = this;
    gl.bindTexture(gl.TEXTURE_2D, this.intermediateTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, this.outputWidth, sourceHeight, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.intermediateFramebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.intermediateTexture, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error("The upscaler could not create its working buffer.");
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.intermediateHeight = sourceHeight;
  }

  private runPass(pass: UpscalePass): void {
    const { gl } = this;
    gl.bindFramebuffer(gl.FRAMEBUFFER, pass.framebuffer);
    gl.viewport(0, 0, pass.outputWidth, pass.outputHeight);
    gl.bindTexture(gl.TEXTURE_2D, pass.sourceTexture);
    gl.uniform1i(this.uniforms.sourceTexture, 0);
    gl.uniform2i(this.uniforms.sourceSize, pass.sourceWidth, pass.sourceHeight);
    gl.uniform2f(this.uniforms.outputSize, pass.outputWidth, pass.outputHeight);
    gl.uniform1i(this.uniforms.isVertical, pass.isVertical ? 1 : 0);
    gl.uniform1i(this.uniforms.flipOutput, pass.flipOutput ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, triangleVertexCount);
  }

  upscale(source: TexImageSource, sourceWidth: number, sourceHeight: number): OffscreenCanvas {
    const { gl } = this;
    this.ensureIntermediateHeight(sourceHeight);
    gl.useProgram(this.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.sourceTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, source);
    this.runPass({
      flipOutput: false,
      framebuffer: this.intermediateFramebuffer,
      isVertical: false,
      outputHeight: sourceHeight,
      outputWidth: this.outputWidth,
      sourceHeight,
      sourceTexture: this.sourceTexture,
      sourceWidth
    });
    this.runPass({
      flipOutput: true,
      framebuffer: null,
      isVertical: true,
      outputHeight: this.outputHeight,
      outputWidth: this.outputWidth,
      sourceHeight,
      sourceTexture: this.intermediateTexture,
      sourceWidth: this.outputWidth
    });
    return this.canvas;
  }

  dispose(): void {
    const { gl } = this;
    gl.deleteFramebuffer(this.intermediateFramebuffer);
    gl.deleteTexture(this.intermediateTexture);
    gl.deleteTexture(this.sourceTexture);
    gl.deleteProgram(this.program);
  }
}

function createProgram(gl: WebGL2RenderingContext): WebGLProgram {
  const program = gl.createProgram();
  gl.attachShader(program, compileShader(gl, gl.VERTEX_SHADER, vertexShaderSource));
  gl.attachShader(program, compileShader(gl, gl.FRAGMENT_SHADER, fragmentShaderSource));
  gl.linkProgram(program);
  if (gl.getProgramParameter(program, gl.LINK_STATUS) !== true) {
    throw new Error(`The upscaler shader could not link: ${gl.getProgramInfoLog(program) ?? ""}`);
  }

  return program;
}

function compileShader(gl: WebGL2RenderingContext, type: GLenum, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) {
    throw new Error("The upscaler shader could not be created.");
  }

  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS) !== true) {
    throw new Error(`The upscaler shader could not compile: ${gl.getShaderInfoLog(shader) ?? ""}`);
  }

  return shader;
}

function createTexture(gl: WebGL2RenderingContext): WebGLTexture {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return texture;
}

function requiredUniform(gl: WebGL2RenderingContext, program: WebGLProgram, name: string): WebGLUniformLocation {
  const location = gl.getUniformLocation(program, name);
  if (!location) {
    throw new Error(`The upscaler shader is missing ${name}.`);
  }

  return location;
}

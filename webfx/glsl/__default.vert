precision highp float;
precision highp int;

attribute vec4 acPos;
attribute vec2 acTexcoord;
varying   vec2 acScreenNorm;

void main(void) {
    gl_Position  = acPos;
    acScreenNorm = acTexcoord;
}

// Shared screen-space packet shader for moving observer and OISL links. Like Cesium's PolylineDash it measures along the line in
// screen space (gl_FragCoord rotated by the line angle). st.s is 0 at the body and 1 at the station;
// its screen derivative tells which way along the line the station lies, so the two packet trains
// keep their direction whatever the camera does. pow(fract(...), 6) is a bright head with a tail.
export const LINK_FLOW_SOURCE = `
uniform vec4 color;
uniform vec4 downColor;
uniform vec4 upColor;
uniform float spacing;
uniform float time;
in float v_polylineAngle;

mat2 rotate(float rad) {
  float c = cos(rad);
  float s = sin(rad);
  return mat2(c, s, -s, c);
}

czm_material czm_getMaterial(czm_materialInput materialInput) {
  czm_material material = czm_getDefaultMaterial(materialInput);
  float s = materialInput.st.s;
  float t = materialInput.st.t;
  float across = 1.0 - abs(2.0 * t - 1.0);
  vec2 pos = rotate(v_polylineAngle) * gl_FragCoord.xy;
  vec2 axis = vec2(cos(v_polylineAngle), -sin(v_polylineAngle));
  float ds = dFdx(s) * axis.x + dFdy(s) * axis.y;
  float towardStation = ds >= 0.0 ? 1.0 : -1.0;
  float u = pos.x * towardStation / (spacing * czm_pixelRatio);
  float down = pow(fract(u - time), 6.0);
  float up = pow(fract(0.5 - u - time * 0.8), 6.0);
  vec3 rgb = mix(color.rgb, downColor.rgb, down);
  float alpha = max(color.a, down * downColor.a);
  rgb = mix(rgb, upColor.rgb, up);
  alpha = max(alpha, up * upColor.a);
  material.diffuse = rgb;
  material.emission = rgb * (0.35 + 0.65 * max(down, up));
  material.alpha = alpha * (0.4 + 0.6 * across);
  return material;
}
`;

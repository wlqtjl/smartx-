import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { computeBloomParams, computeSmaaSize } from './PostFx';
import { configurePbrRenderer, enableShadowsOnSubtree } from './PbrRenderer';

describe('PostFx pure helpers', () => {
  it('computeBloomParams uses sensible defaults', () => {
    const p = computeBloomParams();
    expect(p.strength).toBeCloseTo(0.45);
    expect(p.radius).toBeCloseTo(0.6);
    expect(p.threshold).toBeCloseTo(0.85);
  });

  it('computeBloomParams clamps out-of-range overrides', () => {
    const p = computeBloomParams({ bloomStrength: 99, bloomRadius: -1, bloomThreshold: 5 });
    expect(p.strength).toBe(3);
    expect(p.radius).toBe(0);
    expect(p.threshold).toBe(1);
  });

  it('computeSmaaSize floors and clamps to >= 1', () => {
    expect(computeSmaaSize(800, 600, 1)).toEqual({ w: 800, h: 600 });
    expect(computeSmaaSize(800, 600, 1.5)).toEqual({ w: 1200, h: 900 });
    expect(computeSmaaSize(0, 0, 1)).toEqual({ w: 1, h: 1 });
    expect(computeSmaaSize(100.7, 50.9, 1)).toEqual({ w: 100, h: 50 });
  });
});

describe('configurePbrRenderer', () => {
  function stubRenderer(): {
    shadowMap: { enabled: boolean; type: THREE.ShadowMapType };
    toneMapping: THREE.ToneMapping;
    toneMappingExposure: number;
    outputColorSpace: THREE.ColorSpace;
  } {
    return {
      shadowMap: { enabled: false, type: THREE.BasicShadowMap },
      toneMapping: THREE.NoToneMapping,
      toneMappingExposure: 1,
      outputColorSpace: THREE.LinearSRGBColorSpace,
    };
  }

  it('writes the expected PBR defaults', () => {
    const r = stubRenderer();
    configurePbrRenderer(r);
    expect(r.shadowMap.enabled).toBe(true);
    expect(r.shadowMap.type).toBe(THREE.PCFSoftShadowMap);
    expect(r.toneMapping).toBe(THREE.ACESFilmicToneMapping);
    expect(r.toneMappingExposure).toBe(1);
    expect(r.outputColorSpace).toBe(THREE.SRGBColorSpace);
  });

  it('respects exposure and shadow overrides', () => {
    const r = stubRenderer();
    configurePbrRenderer(r, { exposure: 0.6, shadows: false });
    expect(r.shadowMap.enabled).toBe(false);
    expect(r.toneMappingExposure).toBeCloseTo(0.6);
  });
});

describe('enableShadowsOnSubtree', () => {
  it('flips castShadow / receiveShadow on every Mesh', () => {
    const root = new THREE.Group();
    const m1 = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
    const m2 = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
    const child = new THREE.Group();
    child.add(m2);
    root.add(m1, child);
    enableShadowsOnSubtree(root);
    expect(m1.castShadow).toBe(true);
    expect(m1.receiveShadow).toBe(true);
    expect(m2.castShadow).toBe(true);
    expect(m2.receiveShadow).toBe(true);
  });
});

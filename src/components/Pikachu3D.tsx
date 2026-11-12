import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { SKIN_COLORS, usePetStore, type PetSkin } from "../store/pet";

type PetState =
  | "idle"
  | "walk"
  | "sit"
  | "sleep"
  | "excited"
  | "thinking"
  | "morning"
  | "night"
  | "dance"
  | "stretch"
  | "look"
  | "wave";

interface Pikachu3DProps {
  state: PetState;
  size?: number;
  skin?: PetSkin;
  facing?: "left" | "right";
}

/** 放在 public/models，Vite 原样拷进 dist，Tauri 打包后路径一致。 */
const MODEL_URL = "/models/pet.glb";

interface TintedMaterial {
  material: THREE.MeshStandardMaterial;
  base: THREE.Color;
}

interface MorphTarget {
  mesh: THREE.Mesh;
  dictionary: Record<string, number>;
}

/** 驱动 Blender 烘焙的形态键（Blink / EarWiggle / Wave / Breath）。 */
function setMorph(targets: MorphTarget[], name: string, value: number) {
  targets.forEach(({ mesh, dictionary }) => {
    const index = dictionary[name];
    if (index !== undefined && mesh.morphTargetInfluences) {
      mesh.morphTargetInfluences[index] = value;
    }
  });
}

/** 12 种状态用程序化姿态驱动，模型本身不需要骨骼动画。 */
function applyPose(group: THREE.Group, state: PetState, t: number) {
  let y = 0;
  let rotZ = 0;
  let spin = 0;
  let scaleX = 1;
  let scaleY = 1;

  switch (state) {
    case "idle":
      y = Math.sin(t * 1.8) * 0.03;
      rotZ = Math.sin(t * 1.1) * 0.028;
      scaleY = 1 + Math.sin(t * 1.8) * 0.012;
      break;
    case "walk":
      y = Math.abs(Math.sin(t * 6)) * 0.06;
      rotZ = Math.sin(t * 6) * 0.075;
      spin = Math.sin(t * 6) * 0.05;
      break;
    case "sit":
      y = -0.12;
      scaleY = 0.9;
      scaleX = 1.04;
      break;
    case "sleep":
      y = -0.14;
      rotZ = 0.2;
      scaleY = 0.94 + Math.sin(t * 1.1) * 0.012;
      break;
    case "excited":
      y = Math.abs(Math.sin(t * 7)) * 0.16;
      rotZ = Math.sin(t * 7) * 0.05;
      break;
    case "thinking":
      rotZ = -0.1;
      spin = Math.sin(t * 0.8) * 0.14;
      y = Math.sin(t * 1.2) * 0.015;
      break;
    case "morning":
      scaleY = 1 + Math.sin(t * 1.4) * 0.055;
      rotZ = -0.05;
      y = 0.02;
      break;
    case "night":
      y = -0.1;
      rotZ = 0.14;
      scaleY = 0.96 + Math.sin(t * 0.8) * 0.01;
      break;
    case "dance":
      spin = t * 2;
      y = Math.abs(Math.sin(t * 6)) * 0.08;
      rotZ = Math.sin(t * 6) * 0.07;
      break;
    case "stretch":
      scaleY = 1 + Math.sin(t * 1.5) * 0.075;
      scaleX = 1 - Math.sin(t * 1.5) * 0.025;
      break;
    case "look":
      spin = Math.sin(t * 1.3) * 0.32;
      break;
    case "wave":
      rotZ = Math.sin(t * 5) * 0.12;
      y = Math.sin(t * 5) * 0.01;
      break;
  }

  const ease = 0.16;
  group.position.y += (y - group.position.y) * ease;
  group.rotation.z += (rotZ - group.rotation.z) * ease;
  if (state === "dance") group.rotation.y = spin;
  else group.rotation.y += (spin - group.rotation.y) * ease;
  group.scale.x += (scaleX - group.scale.x) * ease;
  group.scale.y += (scaleY - group.scale.y) * ease;
  group.scale.z = group.scale.x;
}

/**
 * 由 AI 生成的 GLB 桌宠模型驱动（替代原先手写堆球体/圆锥的几何体）。
 * props 与旧组件完全一致，Pet.tsx / Settings.tsx 无需改动。
 */
export function Pikachu3D({ state, size = 128, skin, facing = "right" }: Pikachu3DProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef(state);
  const facingRef = useRef(facing);
  const materialsRef = useRef<TintedMaterial[]>([]);
  const morphRef = useRef<MorphTarget[]>([]);
  const globalSkin = usePetStore((value) => value.skin);
  const resolvedSkin = skin || globalSkin;
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  stateRef.current = state;
  facingRef.current = facing;

  useEffect(() => {
    setStatus("loading");
    const container = containerRef.current;
    if (!container) return;

    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(size, size);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.25;
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 100);
    camera.position.set(0, 1.0, 3.6);
    camera.lookAt(0, 0.92, 0);

    scene.add(new THREE.AmbientLight(0xffffff, 1.5));
    const key = new THREE.DirectionalLight(0xfff4d6, 2.4);
    key.position.set(2.5, 3.5, 3);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xa8c8ff, 0.9);
    fill.position.set(-2.5, 1.5, -2);
    scene.add(fill);

    const shadow = new THREE.Mesh(
      new THREE.CircleGeometry(0.5, 32),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.13, depthWrite: false })
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.02;
    scene.add(shadow);

    const facingGroup = new THREE.Group();
    const animGroup = new THREE.Group();
    scene.add(facingGroup);
    facingGroup.add(animGroup);

    let disposed = false;
    let frame = 0;
    const clock = new THREE.Clock();
    materialsRef.current = [];
    morphRef.current = [];

    new GLTFLoader().load(
      MODEL_URL,
      (gltf) => {
        if (disposed) return;
        const model = gltf.scene;
        const box = new THREE.Box3().setFromObject(model);
        const dims = new THREE.Vector3();
        const center = new THREE.Vector3();
        box.getSize(dims);
        box.getCenter(center);
        // 不管生成模型的原始尺度如何，统一归一化并居中。
        const scale = 1.85 / Math.max(dims.x, dims.y, dims.z, 0.001);
        model.scale.setScalar(scale);
        model.position.set(-center.x * scale, -center.y * scale + 0.95, -center.z * scale);

        model.traverse((object) => {
          if (!(object instanceof THREE.Mesh)) return;
          const list = Array.isArray(object.material) ? object.material : [object.material];
          list.forEach((item) => {
            if (item instanceof THREE.MeshStandardMaterial) {
              materialsRef.current.push({ material: item, base: item.color.clone() });
            }
          });
          if (object.morphTargetDictionary && object.morphTargetInfluences) {
            morphRef.current.push({ mesh: object, dictionary: object.morphTargetDictionary });
          }
        });

        animGroup.add(model);
        setStatus("ready");
      },
      undefined,
      () => {
        if (!disposed) setStatus("error");
      }
    );

    function animate() {
      frame = requestAnimationFrame(animate);
      const t = clock.getElapsedTime();
      const target = facingRef.current === "left" ? Math.PI * 0.2 : -Math.PI * 0.2;
      facingGroup.rotation.y += (target - facingGroup.rotation.y) * 0.08;
      const currentState = stateRef.current;
      applyPose(animGroup, currentState, t);

      const targets = morphRef.current;
      if (targets.length > 0) {
        // 每约 7 秒一次短促眨眼；睡觉时持续闭眼。
        const blink = Math.pow(Math.max(0, Math.sin(t * 0.9)), 24);
        const sleeping = currentState === "sleep" || currentState === "night";
        setMorph(targets, "Blink", sleeping ? 1 : blink);
        setMorph(
          targets,
          "Breath",
          0.5 + Math.sin(t * (sleeping ? 0.8 : 1.8)) * 0.5
        );
        setMorph(
          targets,
          "EarWiggle",
          currentState === "excited" || currentState === "dance"
            ? 0.5 + Math.sin(t * 6) * 0.5
            : 0
        );
        setMorph(
          targets,
          "Wave",
          currentState === "wave" ? 0.5 + Math.sin(t * 5) * 0.5 : 0
        );
      }
      renderer.render(scene, camera);
    }
    animate();

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      scene.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        object.geometry?.dispose();
        const list = Array.isArray(object.material) ? object.material : [object.material];
        list.forEach((item) => {
          if (!item) return;
          Object.values(item).forEach((value) => {
            if (value instanceof THREE.Texture) value.dispose();
          });
          item.dispose();
        });
      });
      renderer.dispose();
      renderer.forceContextLoss();
      if (renderer.domElement.parentNode === container) container.removeChild(renderer.domElement);
      materialsRef.current = [];
      morphRef.current = [];
    };
  }, [size]);

  // 皮肤只做轻微 tint，保留 PBR 贴图细节，不重建场景。
  useEffect(() => {
    const tint = new THREE.Color(SKIN_COLORS[resolvedSkin].body);
    materialsRef.current.forEach(({ material, base }) => material.color.copy(base).lerp(tint, 0.16));
  }, [resolvedSkin, status]);

  return (
    <div style={{ position: "relative", width: size, height: size }}>
      <div ref={containerRef} style={{ width: size, height: size, cursor: "grab" }} />
      {status !== "ready" && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            pointerEvents: "none",
          }}
        >
          <div
            style={{
              width: size * 0.55,
              height: size * 0.55,
              borderRadius: "50%",
              background: "radial-gradient(circle at 35% 30%, #fff6c9, #f7dc6f 60%, #e8b93b)",
              boxShadow: "0 8px 24px rgba(0,0,0,0.18)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 11,
              color: "#7a5c12",
            }}
          >
            {status === "loading" ? "模型加载中…" : "模型加载失败"}
          </div>
        </div>
      )}
    </div>
  );
}

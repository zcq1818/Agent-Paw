import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

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

interface RiggedPet3DProps {
  model: string;
  state: PetState;
  size?: number;
  facing?: "left" | "right";
}

/** 应用状态 -> GLB 里的动作片段名（tools/pets/build_pets.py 生成）。 */
const CLIP_FOR_STATE: Record<PetState, string> = {
  idle: "idle",
  walk: "walk",
  sit: "sit",
  sleep: "sleep",
  excited: "excited",
  thinking: "thinking",
  morning: "stretch",
  night: "sleep",
  dance: "dance",
  stretch: "stretch",
  look: "look",
  wave: "wave",
};

const EYE_SCALE = /(^|\/|\.)eye_[LR]\.scale$/;

/**
 * 带骨骼的 3D 桌宠：AnimationMixer 按状态交叉淡入淡出播放动作片段，
 * 另叠加一个只控制眼睛缩放的 blink 片段（睡觉时停掉）。
 */
export function RiggedPet3D({ model, state, size = 128, facing = "right" }: RiggedPet3DProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef(state);
  const facingRef = useRef(facing);
  const playRef = useRef<(state: PetState) => void>(() => {});
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  facingRef.current = facing;

  useEffect(() => {
    stateRef.current = state;
    playRef.current(state);
  }, [state]);

  useEffect(() => {
    setStatus("loading");
    const container = containerRef.current;
    if (!container) return;

    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(size, size);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.1;
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
    camera.position.set(0, 1.05, 4.2);
    camera.lookAt(0, 0.88, 0);

    scene.add(new THREE.HemisphereLight(0xffffff, 0xb8c4d6, 1.6));
    const key = new THREE.DirectionalLight(0xfff2e0, 2.2);
    key.position.set(2, 3.5, 3);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0xbfe9ff, 0.9);
    rim.position.set(-2.5, 2, -2);
    scene.add(rim);

    const shadow = new THREE.Mesh(
      new THREE.CircleGeometry(0.42, 32),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.12, depthWrite: false })
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.01;
    scene.add(shadow);

    const facingGroup = new THREE.Group();
    scene.add(facingGroup);

    let disposed = false;
    let frame = 0;
    let mixer: THREE.AnimationMixer | null = null;
    let blink: THREE.AnimationAction | null = null;
    let current: THREE.AnimationAction | null = null;
    const actions = new Map<string, THREE.AnimationAction>();
    const clock = new THREE.Clock();

    playRef.current = (next: PetState) => {
      if (!mixer) return;
      const action = actions.get(CLIP_FOR_STATE[next]) || actions.get("idle");
      if (!action || action === current) return;
      action.reset().setEffectiveWeight(1).play();
      if (current) current.crossFadeTo(action, 0.35, false);
      current = action;
      const sleeping = CLIP_FOR_STATE[next] === "sleep";
      if (blink) blink.setEffectiveWeight(sleeping ? 0 : 1);
    };

    new GLTFLoader().load(
      model,
      (gltf) => {
        if (disposed) return;
        const root = gltf.scene;
        root.traverse((object) => {
          if ((object as THREE.Mesh).isMesh) object.frustumCulled = false;
        });
        // 按静止姿态的包围盒归一化：身高约 1.6，脚踩在地面中心。
        const box = new THREE.Box3().setFromObject(root);
        const dims = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        const scale = 1.6 / Math.max(dims.y, dims.x * 1.1, 0.001);
        root.scale.setScalar(scale);
        root.position.set(-center.x * scale, -box.min.y * scale, -center.z * scale);
        facingGroup.add(root);

        mixer = new THREE.AnimationMixer(root);
        for (const clip of gltf.animations) {
          if (clip.name === "blink") {
            const eyesOnly = new THREE.AnimationClip("blink", clip.duration, clip.tracks.filter((t) => EYE_SCALE.test(t.name)));
            blink = mixer.clipAction(eyesOnly);
            blink.play();
            continue;
          }
          // 睡觉片段自己闭眼；其它片段去掉眼睛缩放，交给 blink 叠加。
          const tracks = clip.name === "sleep" ? clip.tracks : clip.tracks.filter((t) => !EYE_SCALE.test(t.name));
          const action = mixer.clipAction(new THREE.AnimationClip(clip.name, clip.duration, tracks));
          action.setLoop(THREE.LoopRepeat, Infinity);
          action.clampWhenFinished = false;
          actions.set(clip.name, action);
        }
        current = null;
        playRef.current(stateRef.current);
        setStatus("ready");
      },
      undefined,
      () => {
        if (!disposed) setStatus("error");
      }
    );

    function animate() {
      frame = requestAnimationFrame(animate);
      const delta = Math.min(clock.getDelta(), 0.1);
      mixer?.update(delta);
      const target = facingRef.current === "left" ? -0.45 : 0.45;
      facingGroup.rotation.y += (target - facingGroup.rotation.y) * 0.08;
      renderer.render(scene, camera);
    }
    animate();

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      mixer?.stopAllAction();
      playRef.current = () => {};
      scene.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.geometry?.dispose();
        const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
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
    };
  }, [model, size]);

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
            fontSize: 11,
            color: "rgb(var(--fg-muted))",
          }}
        >
          {status === "loading" ? "加载中…" : "模型加载失败"}
        </div>
      )}
    </div>
  );
}

import * as THREE from 'three';
import type { SceneSnapshot, SceneViewApi, SceneViewOptions } from './types';

const DEFAULT_BACKGROUND = 0xaed8f2;

/** 在网页容器中创建可复用的舞台，并用程序化几何体展示牛、苹果和草地。 */
export class SceneView implements SceneViewApi {
  readonly shell: HTMLElement;
  readonly stage: HTMLElement;
  readonly canvasHost: HTMLElement;
  readonly threeScene: THREE.Scene;

  private readonly camera: THREE.OrthographicCamera;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly cow: CowRig;
  private readonly apples = new Map<string, THREE.Group>();
  private readonly pocketFlights: Array<{ mesh: THREE.Group; from: THREE.Vector3; elapsed: number }> = [];
  private readonly seenEvents = new Set<string>();
  private readonly clock = new THREE.Clock();
  private readonly resizeObserver: ResizeObserver;
  private animationFrame = 0;
  private speechAmplitude = 0;
  private disposed = false;

  /** 创建或复用根节点约定的舞台节点，并启动渲染循环。 */
  constructor(root: HTMLElement, options: SceneViewOptions = {}) {
    this.shell = ensureElement(root, '.app-shell', 'div', 'app-shell');
    this.stage = ensureElement(this.shell, '.stage', 'section', 'stage');
    this.canvasHost = ensureElement(this.stage, '.scene-canvas', 'div', 'scene-canvas');
    this.canvasHost.setAttribute('aria-label', '牛七七三维场景');

    this.threeScene = new THREE.Scene();
    this.threeScene.background = new THREE.Color(options.background ?? DEFAULT_BACKGROUND);
    this.threeScene.fog = new THREE.Fog(options.background ?? DEFAULT_BACKGROUND, 12, 28);
    this.camera = new THREE.OrthographicCamera(-7, 7, 6.5, -6.5, 0.1, 100);
    this.camera.position.set(0, 14, 14);
    this.camera.lookAt(0, 0, 0);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(options.pixelRatio ?? Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.canvasHost.appendChild(this.renderer.domElement);

    this.addLights();
    this.addGround();
    this.cow = new CowRig();
    this.threeScene.add(this.cow.group);
    this.resizeObserver = new ResizeObserver(() => this.resize(options.width, options.height));
    this.resizeObserver.observe(this.canvasHost);
    this.resize(options.width, options.height);
    this.renderLoop();
  }

  /** 兼容根入口的启动接口；构造时已启动渲染循环，重复调用不会创建新循环。 */
  start(): void {
    if (this.disposed || this.animationFrame !== 0) return;
    this.clock.start();
    this.renderLoop();
  }

  /** 将游戏引擎快照转换为场景快照，并消费一次性表现事件。 */
  render(snapshot: GameSnapshotLike, events: readonly GameEventLike[] = []): void {
    for (const event of events) {
      if (!event.id || this.seenEvents.has(event.id)) continue;
      if (event.type === 'game_started') this.seenEvents.clear();
      this.seenEvents.add(event.id);
      if (event.type === 'game_started') this.clearFlights();
      if (event.type === 'apple_collected') this.flyIntoPocket(event);
    }
    this.update(toSceneSnapshot(snapshot));
  }

  /** 应用最新游戏快照，场景只负责表现，不修改游戏规则。 */
  update(snapshot: SceneSnapshot): void {
    this.cow.setSnapshot(snapshot.cow);
    const activeIds = new Set(snapshot.apples.map((apple) => apple.id));
    for (const [id, mesh] of this.apples) {
      if (!activeIds.has(id)) {
        this.threeScene.remove(mesh);
        disposeObject(mesh);
        this.apples.delete(id);
      }
    }
    for (const apple of snapshot.apples) {
      const mesh = this.apples.get(apple.id) ?? this.createApple(apple.id);
      mesh.position.set(apple.x, 0.55, apple.z);
      const scale = 0.82 + Math.max(0, Math.min(1, apple.lifeRatio)) * 0.18;
      mesh.scale.setScalar(scale);
      mesh.userData.lifeRatio = apple.lifeRatio;
    }
  }

  /** 以 0 到 1 的振幅驱动说话时嘴部开合。 */
  setSpeechAmplitude(value: number): void {
    this.speechAmplitude = Math.max(0, Math.min(1, value));
    this.cow.setSpeechAmplitude(this.speechAmplitude);
  }

  /** 切换聊天与抓苹果模式的角色外观，聊天时摘下眼罩。 */
  setMode(mode: 'chat' | 'apple-game'): void {
    this.cow.setBlindfolded(mode === 'apple-game');
  }

  /** 停止动画循环并释放 Three.js 对象和监听器。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.animationFrame);
    this.resizeObserver.disconnect();
    disposeObject(this.threeScene);
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  /** 配置场景灯光，使程序化模型在移动端也有清晰的体积感。 */
  private addLights(): void {
    const ambient = new THREE.HemisphereLight(0xf5fbff, 0x6f9a60, 2.2);
    this.threeScene.add(ambient);
    const key = new THREE.DirectionalLight(0xffffff, 2.1);
    key.position.set(-4, 8, 5);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    this.threeScene.add(key);
  }

  /** 创建可承载苹果的草地和淡色边界参考面。 */
  private addGround(): void {
    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(8.2, 64),
      new THREE.MeshStandardMaterial({ color: 0x72b85b, roughness: 0.92 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.threeScene.add(ground);

    const ring = new THREE.Mesh(
      new THREE.RingGeometry(8.15, 8.25, 64),
      new THREE.MeshBasicMaterial({ color: 0x3d7d45, transparent: true, opacity: 0.55, side: THREE.DoubleSide }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.012;
    this.threeScene.add(ring);
  }

  /** 创建一个带叶柄和叶子的程序化苹果，并注册到当前场景。 */
  private createApple(id: string): THREE.Group {
    const apple = new THREE.Group();
    apple.name = `apple-${id}`;
    const body = new THREE.Mesh(
      new THREE.SphereGeometry(0.45, 20, 14),
      new THREE.MeshStandardMaterial({ color: 0xe94b43, roughness: 0.72 }),
    );
    body.scale.set(1, 0.92, 1);
    body.castShadow = true;
    apple.add(body);
    const stem = new THREE.Mesh(
      new THREE.CylinderGeometry(0.035, 0.05, 0.22, 8),
      new THREE.MeshStandardMaterial({ color: 0x65432a }),
    );
    stem.position.y = 0.46;
    apple.add(stem);
    const leaf = new THREE.Mesh(
      new THREE.SphereGeometry(0.12, 10, 6),
      new THREE.MeshStandardMaterial({ color: 0x3a8f45 }),
    );
    leaf.scale.set(1.5, 0.35, 0.65);
    leaf.rotation.z = -0.35;
    leaf.position.set(0.12, 0.53, 0);
    apple.add(leaf);
    apple.userData.appleId = id;
    this.apples.set(id, apple);
    this.threeScene.add(apple);
    return apple;
  }

  /** 依据舞台实际尺寸更新画布与相机宽高比。 */
  private resize(width?: number, height?: number): void {
    const rect = this.canvasHost.getBoundingClientRect();
    const nextWidth = width ?? Math.max(1, rect.width);
    const nextHeight = height ?? Math.max(1, rect.height || nextWidth * 0.72);
    this.renderer.setSize(nextWidth, nextHeight, false);
    const aspect = nextWidth / nextHeight;
    const halfWidth = Math.max(6.8, 6 * aspect);
    const halfHeight = Math.max(6, 6.8 / aspect);
    this.camera.left = -halfWidth;
    this.camera.right = halfWidth;
    this.camera.top = halfHeight;
    this.camera.bottom = -halfHeight;
    this.camera.updateProjectionMatrix();
  }

  /** 以浏览器帧循环刷新动作、苹果轻微浮动和三维画面。 */
  private renderLoop = (): void => {
    if (this.disposed) return;
    const delta = Math.min(0.05, this.clock.getDelta());
    const elapsed = this.clock.elapsedTime;
    this.cow.update(delta, elapsed, this.speechAmplitude);
    this.updateFlights(delta);
    for (const apple of this.apples.values()) {
      apple.rotation.y += delta * 0.6;
      apple.position.y = 0.55 + Math.sin(elapsed * 2.2 + Number(apple.userData.appleId?.length ?? 0)) * 0.035;
      const lifeRatio = Number(apple.userData.lifeRatio ?? 1);
      apple.children[0].scale.set(1, 0.9 + Math.max(0.06, lifeRatio) * 0.1, 1);
    }
    this.renderer.render(this.threeScene, this.camera);
    this.animationFrame = requestAnimationFrame(this.renderLoop);
  };

  /** 从规则已判定的抓取位置创建入袋表现，不改动得分或补位时间。 */
  private flyIntoPocket(event: GameEventLike): void {
    const position = event.payload?.position as { x?: unknown; z?: unknown } | undefined;
    if (typeof position?.x !== 'number' || typeof position.z !== 'number') return;
    const id = `effect-${event.id}`;
    const mesh = this.createApple(id);
    this.apples.delete(id);
    const from = new THREE.Vector3(position.x, 0.55, position.z);
    mesh.position.copy(from);
    this.pocketFlights.push({ mesh, from, elapsed: 0 });
  }

  /** 用短弧线把苹果送到口袋挂点，结束后释放临时几何体。 */
  private updateFlights(delta: number): void {
    for (let index = this.pocketFlights.length - 1; index >= 0; index -= 1) {
      const flight = this.pocketFlights[index];
      flight.elapsed += delta;
      const progress = Math.min(1, flight.elapsed / 0.6);
      const destination = this.cow.pocketPosition();
      flight.mesh.position.lerpVectors(flight.from, destination, progress);
      flight.mesh.position.y += Math.sin(progress * Math.PI) * 1.4;
      flight.mesh.scale.setScalar(1 - progress * 0.85);
      if (progress === 1) {
        this.threeScene.remove(flight.mesh);
        disposeObject(flight.mesh);
        this.pocketFlights.splice(index, 1);
      }
    }
  }

  /** 清理上一局未结束的入袋表现，防止新局残留临时苹果。 */
  private clearFlights(): void {
    for (const flight of this.pocketFlights) {
      this.threeScene.remove(flight.mesh);
      disposeObject(flight.mesh);
    }
    this.pocketFlights.length = 0;
  }
}

/** 确保 UI 和场景共享稳定的 DOM 节点契约。 */
function ensureElement(parent: HTMLElement, selector: string, tagName: string, className: string): HTMLElement {
  const existing = parent.querySelector<HTMLElement>(`:scope > ${selector}`);
  if (existing) return existing;
  const element = document.createElement(tagName);
  element.className = className;
  parent.appendChild(element);
  return element;
}

/** 游戏引擎快照的最小结构，避免场景模块依赖规则实现细节。 */
interface GameSnapshotLike {
  phase: 'ready' | 'running' | 'finished';
  score: number;
  remainingMs: number;
  apples: Array<{ id: string; position: { x: number; z: number }; spawnedAt: number; expiresAt: number }>;
  position: { x: number; z: number };
  fatigued: boolean;
  currentAction: string | null;
  endsAt: number | null;
}

/** 游戏事件的最小结构，预留给正式动画事件映射。 */
interface GameEventLike {
  id?: string;
  type?: string;
  payload?: Record<string, unknown>;
}

/** 将规则层快照映射为场景层快照，表现层不自行推进时间。 */
function toSceneSnapshot(snapshot: GameSnapshotLike): SceneSnapshot {
  const pose = snapshot.currentAction === 'left' || snapshot.currentAction === 'right'
    || snapshot.currentAction === 'forward' || snapshot.currentAction === 'backward' ? 'walk'
    : snapshot.currentAction === 'spin' ? 'spin'
      : snapshot.currentAction === 'stop' ? 'stop' : 'idle';
  return {
    phase: snapshot.phase === 'finished' ? 'result' : snapshot.phase,
    cow: { x: snapshot.position.x, z: snapshot.position.z, rotation: 0, pose, tired: snapshot.fatigued },
    apples: snapshot.apples.map((apple) => ({
      id: apple.id, x: apple.position.x, z: apple.position.z,
      lifeRatio: Math.max(0, Math.min(1, (apple.expiresAt - ((snapshot.endsAt ?? 0) - snapshot.remainingMs)) / (apple.expiresAt - apple.spawnedAt))),
    })),
    score: snapshot.score,
  };
}

/** 创建卡通牛的程序化占位模型，供正式 GLB 资产接入前验证动作链路。 */
class CowRig {
  readonly group = new THREE.Group();
  private readonly body: THREE.Group;
  private readonly head: THREE.Group;
  private readonly mouth: THREE.Mesh;
  private readonly legs: THREE.Mesh[];
  private readonly pocket: THREE.Mesh;
  private blindfold!: THREE.Mesh;
  private pose: SceneSnapshot['cow']['pose'] = 'idle';
  private tired = false;
  private target = { x: 0, z: 0, rotation: 0 };
  private spinRotation = 0;

  /** 构建牛身、头部、四肢、眼罩、口袋和尾巴。 */
  constructor() {
    this.group.name = 'niuqiqi-programmatic-placeholder';
    this.body = new THREE.Group();
    this.body.position.y = 1.45;
    this.group.add(this.body);
    const fur = new THREE.MeshStandardMaterial({ color: 0xf6eee0, roughness: 0.9 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x8f5d42, roughness: 0.85 });
    const pink = new THREE.MeshStandardMaterial({ color: 0xf19b91, roughness: 0.82 });

    const torso = new THREE.Mesh(new THREE.SphereGeometry(1.15, 24, 16), fur);
    torso.scale.set(1.18, 1.05, 0.9);
    torso.castShadow = true;
    this.body.add(torso);
    this.head = new THREE.Group();
    this.head.position.set(0, 1.25, 0.08);
    this.body.add(this.head);
    const headMesh = new THREE.Mesh(new THREE.SphereGeometry(0.76, 24, 16), fur);
    headMesh.scale.set(1.05, 1.08, 0.96);
    headMesh.castShadow = true;
    this.head.add(headMesh);
    const muzzle = new THREE.Mesh(new THREE.SphereGeometry(0.38, 18, 12), pink);
    muzzle.scale.set(1.15, 0.72, 0.7);
    muzzle.position.set(0, -0.17, 0.66);
    this.head.add(muzzle);
    this.mouth = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.035, 0.012), dark);
    this.mouth.position.set(0, -0.2, 0.93);
    this.head.add(this.mouth);
    this.addEyesAndBlindfold(dark);
    this.addHorns(fur);
    this.legs = [
      this.addLeg(-0.58, 0.45), this.addLeg(0.58, 0.45), this.addLeg(-0.58, -0.45), this.addLeg(0.58, -0.45),
    ];
    this.pocket = new THREE.Mesh(new THREE.SphereGeometry(0.4, 16, 10), dark);
    this.pocket.name = 'pocket-hook';
    this.pocket.scale.set(1.3, 0.72, 0.28);
    this.pocket.position.set(0, -0.12, 0.92);
    this.body.add(this.pocket);
    const tail = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.06, 0.75, 8), dark);
    tail.position.set(0, 0.35, -0.96);
    tail.rotation.x = Math.PI / 2.9;
    this.body.add(tail);
    this.group.position.y = 0;
  }

  /** 添加眼睛和可表现蒙眼玩法的眼罩。 */
  private addEyesAndBlindfold(dark: THREE.Material): void {
    for (const x of [-0.27, 0.27]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.08, 10, 8), dark);
      eye.position.set(x, 0.12, 0.68);
      this.head.add(eye);
    }
    const blindfold = new THREE.Mesh(
      new THREE.BoxGeometry(0.88, 0.25, 0.12),
      new THREE.MeshStandardMaterial({ color: 0x40344f, roughness: 0.7 }),
    );
    blindfold.name = 'blindfold';
    blindfold.position.set(0, 0.12, 0.72);
    this.head.add(blindfold);
    this.blindfold = blindfold;
  }

  /** 添加两只圆润牛角。 */
  private addHorns(material: THREE.Material): void {
    for (const x of [-0.42, 0.42]) {
      const horn = new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.36, 12), material);
      horn.position.set(x, 0.78, 0.05);
      horn.rotation.z = x < 0 ? -0.25 : 0.25;
      this.head.add(horn);
    }
  }

  /** 添加一条可摆动的程序化腿。 */
  private addLeg(x: number, z: number): THREE.Mesh {
    const leg = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.15, 0.72, 6, 12),
      new THREE.MeshStandardMaterial({ color: 0xf6eee0, roughness: 0.9 }),
    );
    leg.position.set(x, -0.92, z);
    leg.castShadow = true;
    this.body.add(leg);
    return leg;
  }

  /** 记录外部姿态快照，并平滑跟随角色位置与朝向。 */
  setSnapshot(cow: SceneSnapshot['cow']): void {
    this.target = { x: cow.x, z: cow.z, rotation: cow.rotation };
    this.pose = cow.pose;
    this.tired = cow.tired || cow.pose === 'tired';
  }

  /** 控制是否显示蒙眼眼罩。 */
  setBlindfolded(value: boolean): void { this.blindfold.visible = value; }

  /** 更新移动插值和占位动作的轻量姿态。 */
  update(delta: number, elapsed: number, speechAmplitude: number): void {
    this.group.position.x = THREE.MathUtils.damp(this.group.position.x, this.target.x, 8, delta);
    this.group.position.z = THREE.MathUtils.damp(this.group.position.z, this.target.z, 8, delta);
    if (this.pose === 'spin') this.spinRotation += delta * Math.PI * 2 / 1.4;
    else this.spinRotation = 0;
    this.group.rotation.y = this.target.rotation + this.spinRotation;
    const breathing = Math.sin(elapsed * 2.4) * 0.02;
    this.body.position.y = 1.45 + breathing;
    this.mouth.scale.y = 1 + speechAmplitude * 5;
    this.applyPose(elapsed);
  }

  /** 将动作名称映射到可观察的程序化姿态，等待正式动作资源替换。 */
  private applyPose(elapsed: number): void {
    const walk = this.pose === 'walk' ? Math.sin(elapsed * 10) * 0.32 : 0;
    this.legs[0].rotation.x = walk;
    this.legs[1].rotation.x = -walk;
    this.legs[2].rotation.x = -walk;
    this.legs[3].rotation.x = walk;
    this.head.rotation.z = this.tired ? 0.16 : this.pose === 'talk' ? Math.sin(elapsed * 8) * 0.04 : 0;
    this.body.rotation.z = this.tired ? 0.12 : 0;
    if (this.tired) {
      this.body.position.y += Math.sin(elapsed * 7) * 0.06;
      this.legs[0].rotation.x = -0.35;
      this.legs[1].rotation.x = -0.35;
      this.head.rotation.x = 0.22;
    } else this.head.rotation.x = 0;
  }

  /** 读取口袋世界坐标，供苹果入袋动画使用。 */
  pocketPosition(): THREE.Vector3 {
    this.group.updateMatrixWorld(true);
    return this.pocket.getWorldPosition(new THREE.Vector3());
  }

  /** 更新说话振幅对应的嘴部显示。 */
  setSpeechAmplitude(value: number): void {
    this.mouth.scale.y = 1 + Math.max(0, Math.min(1, value)) * 5;
  }
}

/** 释放对象及其材质、几何体，避免重复开局造成 GPU 资源累积。 */
function disposeObject(object: THREE.Object3D): void {
  object.traverse((child: THREE.Object3D) => {
    const mesh = child as THREE.Mesh;
    mesh.geometry?.dispose();
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) material?.dispose();
  });
}

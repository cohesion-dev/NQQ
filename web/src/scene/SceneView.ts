import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { ChatSkillPlayer, type ChatClipPlayback, type ChatSkillResult } from './ChatSkillPlayer';
import { WalkCycle } from './WalkCycle';
import type { ChatSkill } from '../../../shared/tools';
import { CIRCLE_DURATION_SECONDS, sampleCircleMotion } from '../../../shared/circle-motion';
import type { SceneSnapshot, SceneViewApi, SceneViewOptions } from './types';

const DEFAULT_BACKGROUND = 0xaed8f2;
const COW_MODEL_URL = new URL('../../../assets/niu_qi_qi.glb', import.meta.url).href;
export const DANCE_CLIPS = ['All_Night_Dance', 'Stage_Walk', 'Hip_Hop_Dance', 'Hip_Hop_Dance_2'] as const;

/** 在网页容器中创建可复用的舞台，并用程序化几何体展示牛、苹果和草地。 */
export class SceneView implements SceneViewApi {
  readonly shell: HTMLElement;
  readonly stage: HTMLElement;
  readonly canvasHost: HTMLElement;
  readonly threeScene: THREE.Scene;

  private readonly camera: THREE.OrthographicCamera;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly cow: CowRig;
  private modelCow: ModelRig | null = null;
  private currentCowSnapshot: SceneSnapshot['cow'] | null = null;
  private readonly apples = new Map<string, THREE.Group>();
  private readonly pocketFlights: Array<{ mesh: THREE.Group; from: THREE.Vector3; elapsed: number }> = [];
  private readonly seenEvents = new Set<string>();
  private readonly clock = new THREE.Clock();
  private readonly resizeObserver: ResizeObserver;
  private mode: 'chat' | 'apple-game' = 'chat';
  private readonly chatSkills = new ChatSkillPlayer();
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
    this.chatSkills.content.add(this.cow.group);
    this.threeScene.add(this.chatSkills.group);
    this.loadCowModel();
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
    this.currentCowSnapshot = this.mode === 'chat'
      ? { x: 0, z: 0, rotation: 0, pose: 'idle', tired: false }
      : snapshot.cow;
    this.cow.setSnapshot(this.currentCowSnapshot);
    this.modelCow?.setSnapshot(this.currentCowSnapshot);
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
    this.modelCow?.setSpeechAmplitude(this.speechAmplitude);
  }

  /** 切换聊天与抓苹果模式的角色外观，聊天时摘下眼罩。 */
  setMode(mode: 'chat' | 'apple-game'): void {
    if (this.mode !== mode) this.cancelChatSkill();
    this.mode = mode;
    this.cow.setBlindfolded(mode === 'apple-game');
    this.modelCow?.setMode(mode);
    if (mode === 'chat') {
      this.currentCowSnapshot = { x: 0, z: 0, rotation: 0, pose: 'idle', tired: false };
      this.cow.setSnapshot(this.currentCowSnapshot);
      this.modelCow?.setSnapshot(this.currentCowSnapshot);
    }
    this.applyCameraMode();
  }

  /** 聊天技能独立于游戏和模型骨骼片段，返回值表示实际结束或取消。 */
  playChatSkill(skill: ChatSkill): Promise<ChatSkillResult> {
    if (this.mode !== 'chat' || this.disposed) {
      return Promise.resolve({ status: 'rejected', action: skill, mode: 'chat', reason: 'chat_unavailable' });
    }
    this.cancelIdleDance();
    if (this.chatSkills.isPlaying) {
      return Promise.resolve({ status: 'rejected', action: skill, mode: 'chat', reason: 'skill_busy' });
    }
    return this.chatSkills.play(skill, this.modelCow?.prepareChatPlayback(skill));
  }

  /** 向空闲计时提供统一占用状态，包含真实动画和程序化绕圈。 */
  get isChatSkillPlaying(): boolean { return this.chatSkills.isPlaying; }

  /** 自动表演复用同一随机舞蹈入口，不向灵矽伪造工具调用。 */
  playIdleDance(): void {
    if (this.mode !== 'chat' || this.disposed || !this.modelCow || this.chatSkills.isPlaying) return;
    void this.chatSkills.play('dance', this.modelCow.prepareChatPlayback('dance'), true);
  }

  /** 用户开口和指令到达时，仅中止自动触发的表演。 */
  cancelIdleDance(): void {
    if (this.chatSkills.isAutomatic) this.chatSkills.cancel();
  }

  /** 取消独立的聊天技能，不启动或改变苹果游戏。 */
  cancelChatSkill(): void {
    this.chatSkills.cancel();
  }

  /** 停止动画循环并释放 Three.js 对象和监听器。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelChatSkill();
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

  /** 根据模式切换聊天正视角和抓苹果斜上方视角。 */
  private applyCameraMode(): void {
    if (this.mode === 'chat') {
      this.camera.position.set(0, 3.2, 14);
      this.camera.lookAt(0, 1.6, 0);
    } else {
      this.camera.position.set(0, 14, 14);
      this.camera.lookAt(0, 0, 0);
    }
  }

  /** 以浏览器帧循环刷新动作、苹果轻微浮动和三维画面。 */
  private renderLoop = (): void => {
    if (this.disposed) return;
    const delta = Math.min(0.05, this.clock.getDelta());
    const elapsed = this.clock.elapsedTime;
    this.chatSkills.update(delta);
    this.cow.setChatWalking(this.chatSkills.isCircling);
    this.modelCow?.setChatWalking(this.chatSkills.isCircling);
    this.cow.update(delta, elapsed, this.speechAmplitude);
    this.modelCow?.update(delta);
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

  /** 异步加载用户提供的 GLB，加载成功后替换程序化牛并保留兜底模型。 */
  private loadCowModel(): void {
    const loader = new GLTFLoader();
    loader.load(
      COW_MODEL_URL,
      (gltf) => {
        const object = gltf.scene;
        if (this.disposed) {
          disposeObject(object);
          return;
        }
        this.modelCow = new ModelRig(object, gltf.animations);
        this.chatSkills.content.add(this.modelCow.group);
        this.modelCow.setMode(this.mode);
        this.cow.group.visible = false;
        if (this.currentCowSnapshot) this.modelCow.setSnapshot(this.currentCowSnapshot);
        console.info(`Loaded GLB cow model; animations=${gltf.animations.map((clip) => clip.name).join(',') || 'none'}`);
      },
      undefined,
      () => console.warn('GLB cow model failed to load; using programmatic cow'),
    );
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
  actionPhase: string | null;
  actionProgress: number;
  heading: 'front' | 'left' | 'back' | 'right';
  targetHeading: 'front' | 'left' | 'back' | 'right' | null;
  endsAt: number | null;
}

/** 游戏事件的最小结构，预留给正式动画事件映射。 */
interface GameEventLike {
  id?: string;
  type?: string;
  payload?: Record<string, unknown>;
}

/** 将规则层快照映射为场景层快照，表现层不自行推进时间。 */
export function toSceneSnapshot(snapshot: GameSnapshotLike): SceneSnapshot {
  const angles = { front: 0, right: Math.PI / 2, back: Math.PI, left: -Math.PI / 2 };
  const headingRotation = angles[snapshot.heading];
  const circle = snapshot.actionPhase === 'spin' ? sampleCircleMotion(snapshot.actionProgress * CIRCLE_DURATION_SECONDS) : null;
  const turning = snapshot.actionPhase === 'turn' || snapshot.actionPhase === 'face_front';
  const targetRotation = snapshot.actionPhase === 'face_front' ? 0 : angles[snapshot.targetHeading ?? snapshot.heading];
  let turnAngle = Math.atan2(Math.sin(targetRotation - headingRotation), Math.cos(targetRotation - headingRotation));
  if (Math.abs(Math.abs(turnAngle) - Math.PI) < 1e-6) turnAngle = -Math.PI;
  const pose = turning ? (Math.abs(turnAngle) > Math.PI / 2 + 1e-6 ? 'turn_back' : turnAngle < 0 ? 'turn_left' : 'turn_right')
      : snapshot.actionPhase === 'somersault' ? 'somersault'
        : snapshot.actionPhase === 'spin' ? 'spin'
          : snapshot.actionPhase === 'walk' ? 'walk'
    : snapshot.currentAction === 'stop' ? 'stop' : 'idle';
  return {
    phase: snapshot.phase === 'finished' ? 'result' : snapshot.phase,
    cow: {
      x: snapshot.position.x, z: snapshot.position.z,
      rotation: circle?.rotation ?? headingRotation + (turning ? turnAngle * snapshot.actionProgress : 0),
      pose, tired: snapshot.fatigued, actionProgress: snapshot.actionProgress,
      turnSteps: turning ? Math.max(1, Math.round(Math.abs(turnAngle) / (Math.PI / 2))) : 1,
    },
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
  private readonly eyes: THREE.Mesh[] = [];
  private readonly brows: THREE.Mesh[] = [];
  private readonly pocket: THREE.Mesh;
  private blindfold!: THREE.Mesh;
  private pose: SceneSnapshot['cow']['pose'] = 'idle';
  private tired = false;
  private target = { x: 0, z: 0, rotation: 0 };
  private chatWalking = false;

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
      eye.userData.baseX = x;
      this.head.add(eye);
      this.eyes.push(eye);
      const brow = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.035, 0.02), dark);
      brow.position.set(x, 0.31, 0.69);
      this.head.add(brow);
      this.brows.push(brow);
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

  /** 聊天绕圈时用现有程序化腿部交替迈步。 */
  setChatWalking(value: boolean): void { this.chatWalking = value; }

  /** 更新移动插值和占位动作的轻量姿态。 */
  update(delta: number, elapsed: number, speechAmplitude: number): void {
    this.group.position.x = this.pose === 'spin' ? this.target.x : THREE.MathUtils.damp(this.group.position.x, this.target.x, 8, delta);
    this.group.position.z = this.pose === 'spin' ? this.target.z : THREE.MathUtils.damp(this.group.position.z, this.target.z, 8, delta);
    this.group.rotation.y = this.target.rotation;
    const breathing = Math.sin(elapsed * 2.4) * 0.02;
    this.body.position.y = 1.45 + breathing;
    this.applyPose(elapsed);
    this.mouth.scale.y += speechAmplitude * 5;
  }

  /** 将动作名称映射到可观察的程序化姿态，等待正式动作资源替换。 */
  private applyPose(elapsed: number): void {
    const moving = this.chatWalking || this.pose === 'spin' || this.pose === 'walk' || this.pose.startsWith('turn_');
    const walk = moving ? Math.sin(elapsed * 10) * 0.32 : 0;
    this.legs[0].rotation.x = walk;
    this.legs[1].rotation.x = -walk;
    this.legs[2].rotation.x = -walk;
    this.legs[3].rotation.x = walk;
    this.head.rotation.z = this.tired ? 0.16 : this.pose === 'talk' ? Math.sin(elapsed * 8) * 0.04 : moving ? Math.sin(elapsed * 6) * 0.08 : 0;
    this.body.rotation.z = this.tired ? 0.12 : 0;
    this.body.rotation.x = this.pose === 'somersault' ? elapsed * Math.PI * 2.4 : 0;
    const tired = this.tired;
    const surprised = this.pose.startsWith('turn_') || this.pose === 'somersault';
    const dizzy = this.pose === 'spin';
    this.mouth.scale.set(1 + (surprised || dizzy ? 0.35 : 0), 1 + (tired ? 2.8 : surprised || dizzy ? 1.4 : 0), 1);
    this.eyes.forEach((eye) => { eye.scale.y = tired ? 0.55 : dizzy ? 0.8 : 1; });
    this.brows.forEach((brow, index) => {
      brow.rotation.z = tired ? (index === 0 ? -0.28 : 0.28) : surprised ? (index === 0 ? 0.18 : -0.18) : 0;
    });
    this.eyes.forEach((eye) => {
      eye.position.x = Number(eye.userData.baseX) + Math.sin(elapsed * 1.6) * 0.035;
      eye.position.y = 0.12 + Math.sin(elapsed * 1.2) * 0.012;
    });
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

/** 负责归一化、播放和驱动用户提供的 GLB 模型。 */
export class ModelRig {
  readonly group = new THREE.Group();
  private readonly mixer: THREE.AnimationMixer;
  private readonly actions = new Map<string, THREE.AnimationAction>();
  private readonly faceBones: THREE.Bone[] = [];
  private readonly morphTargets: Array<{ mesh: THREE.Mesh; names: Record<string, number> }> = [];
  private activeAction: THREE.AnimationAction | null = null;
  private currentPose = '';
  private speechAmplitude = 0;
  private readonly walkCycle: WalkCycle;
  private pose = 'idle';
  private readonly hips: THREE.Object3D | undefined;
  private readonly hipsPosition: THREE.Vector3 | undefined;
  private readonly hipsYaw: number;
  private readonly turnEuler = new THREE.Euler(0, 0, 0, 'YXZ');
  private chatWalking = false;
  private chatAction: THREE.AnimationAction | null = null;
  private actionProgress = 0;
  private turnSteps = 1;
  private elapsed = 0;

  /** 加载模型后统一尺寸、落地并建立动画片段索引。 */
  constructor(object: THREE.Group, clips: THREE.AnimationClip[], private readonly random: () => number = Math.random) {
    this.walkCycle = new WalkCycle(object);
    this.hips = object.getObjectByName('mixamorigHips');
    this.hipsPosition = this.hips?.position.clone();
    this.hipsYaw = this.hips ? this.turnEuler.setFromQuaternion(this.hips.quaternion, 'YXZ').y : 0;
    object.traverse((child) => {
      if (child instanceof THREE.Bone && /head|face|jaw|eye|mouth|neck/i.test(child.name)) this.faceBones.push(child);
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of materials) {
        if ('side' in material) material.side = THREE.DoubleSide;
      }
      if (mesh.morphTargetDictionary) this.morphTargets.push({ mesh, names: mesh.morphTargetDictionary });
    });
    const bounds = new THREE.Box3().setFromObject(object);
    const size = bounds.getSize(new THREE.Vector3());
    const center = bounds.getCenter(new THREE.Vector3());
    const scale = size.y > 0 ? 3.2 / size.y : 1;
    object.scale.setScalar(scale);
    object.position.set(-center.x * scale, -bounds.min.y * scale, -center.z * scale);
    this.group.name = 'niuqiqi-glb-model';
    this.group.add(object);
    this.mixer = new THREE.AnimationMixer(object);
    for (const clip of clips) {
      this.actions.set(clip.name.toLowerCase(), this.mixer.clipAction(clip));
    }
    console.info(`GLB face controls: bones=${this.faceBones.length}, morphMeshes=${this.morphTargets.length}`);
  }

  /** 将规则姿态映射到实际片段，缺失时停留原姿态，不能误播跑步。 */
  setSnapshot(snapshot: SceneSnapshot['cow']): void {
    this.group.position.set(snapshot.x, 0, snapshot.z);
    this.group.rotation.y = snapshot.rotation;
    this.pose = snapshot.pose === 'walk' ? (snapshot.tired ? 'walk' : 'run')
      : snapshot.tired && snapshot.pose === 'idle' ? 'tired' : snapshot.pose;
    this.actionProgress = snapshot.actionProgress ?? 0;
    this.turnSteps = snapshot.turnSteps ?? 1;
    this.selectAction();
  }

  /** 随机舞蹈和后空翻取得独占播放权，结束后恢复基础姿态。 */
  prepareChatPlayback(skill: ChatSkill): ChatClipPlayback | undefined {
    if (skill === 'spin') return undefined;
    const name = skill === 'dance' ? DANCE_CLIPS[Math.floor(this.random() * DANCE_CLIPS.length)] : 'Backflip';
    const action = this.actions.get(name.toLowerCase());
    if (!action) return undefined;
    this.activeAction?.stop();
    this.activeAction = null;
    this.chatAction = action;
    return {
      action,
      release: () => {
        this.chatAction = null;
        this.currentPose = '';
        this.selectAction();
      },
    };
  }

  /** 游戏依据疲惫状态切换跑走，聊天片段播放时不能被基础快照覆盖。 */
  private selectAction(): void {
    if (this.chatAction) return;
    const pose = this.chatWalking ? 'walk' : this.pose;
    if (pose === this.currentPose) return;
    this.currentPose = pose;
    const action = this.findAction(pose);
    if (action === this.activeAction) return;
    if (!action) {
      this.activeAction?.stop();
      this.activeAction = null;
      return;
    }
    this.activeAction?.stop();
    action.reset().setLoop(THREE.LoopRepeat, Infinity).play();
    action.clampWhenFinished = false;
    action.paused = !this.chatWalking && (pose.startsWith('turn_') || pose === 'somersault');
    this.activeAction = action;
  }

  /** 同步聊天/游戏模式的眼罩状态；模型有命名节点时直接切换。 */
  setMode(mode: 'chat' | 'apple-game'): void {
    this.group.traverse((child) => {
      if (/blindfold|eye_mask|eyemask/i.test(child.name)) child.visible = mode === 'apple-game';
    });
  }

  /** 聊天绕圈时优先使用模型行走片段，缺失才驱动腿骨。 */
  setChatWalking(value: boolean): void {
    if (this.chatWalking === value) return;
    this.chatWalking = value;
    this.selectAction();
  }

  /** 推进模型动画，并锁定水平根位移以服从游戏轨迹。 */
  update(delta: number): void {
    this.elapsed += delta;
    // 游戏阶段由规则时钟采样，避免一秒转身片段被三百毫秒规则截断。
    if (!this.chatAction && this.activeAction?.paused) {
      const progress = this.pose.startsWith('turn_') ? (this.actionProgress * this.turnSteps) % 1 : this.actionProgress;
      this.activeAction.time = Math.min(1 - 1e-6, progress) * this.activeAction.getClip().duration;
    }
    this.mixer.update(delta);
    this.walkCycle.update(this.elapsed, this.chatWalking && !this.findAction('walk'));
    if (this.hips && this.hipsPosition) {
      this.hips.position.x = this.hipsPosition.x;
      this.hips.position.z = this.hipsPosition.z;
      if (!this.chatAction && this.currentPose.startsWith('turn_')) {
        // 朝向由外层轨迹控制，去掉骨盆动画的水平旋转，保留俯仰与侧倾。
        this.turnEuler.setFromQuaternion(this.hips.quaternion, 'YXZ');
        this.turnEuler.y = this.hipsYaw;
        this.hips.quaternion.setFromEuler(this.turnEuler);
      }
    }
    if (!this.chatAction && !this.activeAction) this.applyExpression();
  }

  /** 使用形态目标或面部骨骼表现疲惫、惊讶、兴奋和说话等表情。 */
  private applyExpression(): void {
    const expression = this.currentPose === 'tired' ? 'tired'
      : this.currentPose === 'spin' ? 'dizzy'
      : this.currentPose === 'somersault' ? 'excited'
          : this.currentPose === 'talk' ? 'talk' : this.currentPose === 'idle' ? 'idle' : 'focused';
    for (const { mesh, names } of this.morphTargets) {
      if (!mesh.morphTargetInfluences) continue;
      for (const [name, index] of Object.entries(names)) {
        const normalized = name.toLowerCase();
        let value = 0;
        if (expression === 'tired' && /tired|sad|frown|mouthopen/.test(normalized)) value = 0.8;
        if (expression === 'dizzy' && /dizzy|confused|blink/.test(normalized)) value = 0.8;
        if (expression === 'excited' && /happy|smile|excited|mouthopen/.test(normalized)) value = 0.9;
        if (expression === 'talk' && /mouth|talk|open/.test(normalized)) value = this.speechAmplitude;
        if (expression === 'idle' && /smile|happy/.test(normalized)) value = 0.25;
        mesh.morphTargetInfluences[index] = value;
      }
    }
    for (const bone of this.faceBones) {
      if (/jaw|mouth/i.test(bone.name)) bone.rotation.x = -this.speechAmplitude * 0.25;
      if (/head|face/i.test(bone.name)) bone.rotation.z = expression === 'tired' ? 0.14 : expression === 'dizzy' ? Math.sin(performance.now() / 120) * 0.08 : 0;
      if (/eye/i.test(bone.name)) {
        bone.rotation.y = Math.sin(performance.now() / 700) * 0.08;
        bone.rotation.x = Math.sin(performance.now() / 900) * 0.04;
      }
    }
  }

  /** 接收统一的说话振幅，驱动模型的嘴部形态或下颌骨。 */
  setSpeechAmplitude(value: number): void { this.speechAmplitude = Math.max(0, Math.min(1, value)); }

  /** 将游戏姿态映射到导出名称，待机缺失时不误播跑步。 */
  private findAction(pose: string): THREE.AnimationAction | null {
    const mapping: Record<string, string> = {
      walk: 'walking',
      run: 'running',
      spin: 'walking',
      turn_left: 'idle_turn_left',
      turn_right: 'idle_turn_right',
      turn_back: 'idle_turn_left',
      somersault: 'backflip',
    };
    const exact = this.actions.get(pose.toLowerCase());
    if (exact) return exact;
    return this.actions.get(mapping[pose]) ?? null;
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

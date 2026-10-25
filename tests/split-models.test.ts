import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { IDLE_EXCLUDED_CLIPS, ModelRig, SceneView } from '../web/src/scene/SceneView.ts';
import { ChatSkillPlayer } from '../web/src/scene/ChatSkillPlayer.ts';

/** 实际加载两套不同骨架，验证模式隔离、顺序循环、中断与转向映射。 */
export async function testSplitModels(): Promise<void> {
  const originalSelf = Object.getOwnPropertyDescriptor(globalThis, 'self');
  const originalLoad = THREE.TextureLoader.prototype.load;
  const assets = [];
  try {
    Object.defineProperty(globalThis, 'self', { configurable: true, value: globalThis });
    THREE.TextureLoader.prototype.load = function (_url, onLoad): THREE.Texture {
      const texture = new THREE.Texture();
      queueMicrotask(() => onLoad?.(texture));
      return texture;
    };
    for (const name of ['game', 'idle']) {
      const bytes = await readFile(`assets/${name}.glb`);
      assets.push(await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), ''));
    }
  } finally {
    THREE.TextureLoader.prototype.load = originalLoad;
    if (originalSelf) Object.defineProperty(globalThis, 'self', originalSelf);
    else Reflect.deleteProperty(globalThis, 'self');
  }
  const [game, idle] = assets;
  assert.equal(game.scene.getObjectsByProperty('type', 'Bone').length, 28);
  assert.equal(idle.scene.getObjectsByProperty('type', 'Bone').length, 38);
  const gameRig = new ModelRig(game.scene, game.animations);
  const idleRig = new ModelRig(idle.scene, idle.animations, () => 0);
  const player = new ChatSkillPlayer();
  player.content.add(gameRig.group, idleRig.group);
  const scene: SceneView = Object.create(SceneView.prototype);
  const fallback = { group: new THREE.Group(), setBlindfolded() {}, setSnapshot() {} };
  Object.assign(scene, { mode: 'chat', disposed: false, gameCow: gameRig, idleCow: idleRig,
    modelCow: null, cow: fallback, chatSkills: player, speechAmplitude: 0,
    camera: new THREE.OrthographicCamera() });
  scene.setMode('chat');
  assert.equal(idleRig.group.visible, true);
  assert.equal(gameRig.group.visible, false);
  assert.equal(fallback.group.visible, false);
  idleRig.setTalking(true);
  assert.equal((idleRig as unknown as { talkingAction: THREE.AnimationAction }).talkingAction?.getClip().name, 'Talk_with_Hands_Open');
  idleRig.setTalking(false);

  const idleClips = idle.animations.map((clip) => clip.name).filter((name) => !IDLE_EXCLUDED_CLIPS.has(name));
  for (let index = 0; index < idleClips.length * 2; index += 1) {
    scene.playIdleDance();
    assert.equal(player.isAutomatic, true);
    // 使用真实混合器的激活动作及骨骼变换，不按文件名猜测完成。
    const action = (idleRig as unknown as { chatAction: THREE.AnimationAction }).chatAction;
    assert.equal(idleClips.includes(action.getClip().name), true);
    idleRig.update(action.getClip().duration / 2);
    assert.equal(player.isPlaying, true);
    idleRig.update(action.getClip().duration / 2 + 0.001);
    assert.equal(player.isPlaying, false);
    assert.deepEqual(idleRig.group.position.toArray(), [0, 0, 0]);
  }
  scene.playIdleDance();
  scene.cancelIdleDance();
  scene.playIdleDance();
  const restarted = (idleRig as unknown as { chatAction: THREE.AnimationAction }).chatAction;
  assert.equal(idleClips.includes(restarted.getClip().name), true, 'Cancelled clip must restart from a valid idle action');
  scene.setMode('apple-game');
  assert.equal(player.isPlaying, false);
  assert.equal(idleRig.group.visible, false);
  assert.equal(gameRig.group.visible, true);
  scene.playIdleDance();
  assert.equal(player.isPlaying, false);

  const target = { x: 2, z: -1, rotation: -Math.PI / 2, tired: false, pose: 'turn_left' as const, actionProgress: 0.5 };
  const bone = game.scene.getObjectByName('mixamorigLeftUpLeg')!;
  const hips = game.scene.getObjectByName('mixamorigHips')!;
  const restHips = hips.position.clone();
  for (const [pose, name] of [['turn_left', 'Walk_Turn_Left'], ['turn_right', 'Walk_Turn_Right'], ['walk', 'Running'], ['backward', 'Walk_Backward']] as const) {
    gameRig.setSnapshot({ ...target, pose });
    gameRig.update(0.2);
    const reference = game.scene.clone(true);
    const mixer = new THREE.AnimationMixer(reference);
    const clip = game.animations.find(c => c.name === name)!;
    mixer.clipAction(clip).play();
    mixer.update(pose === 'walk' ? 0.2 : clip.duration * 0.5);
    const activeClip = (gameRig as unknown as { activeAction: THREE.AnimationAction | null }).activeAction?.getClip().name;
    assert.equal(activeClip, name);
    if (pose !== 'backward') {
      assert(bone.quaternion.clone().normalize().angleTo(reference.getObjectByName(bone.name)!.quaternion.clone().normalize()) < 1e-5);
    }
    assert.equal(hips.position.x, restHips.x);
    assert.equal(hips.position.z, restHips.z);
    assert.deepEqual(gameRig.group.position.toArray(), [2, 0, -1]);
    assert.equal(gameRig.group.rotation.y, target.rotation);
    mixer.uncacheRoot(reference);
  }
  scene.setMode('chat');
  scene.playIdleDance();
  const first = (idleRig as unknown as { chatAction: THREE.AnimationAction }).chatAction;
  assert.equal(first.getClip().name, idleClips[0]);
  assert.deepEqual(idleRig.group.position.toArray(), [0, 0, 0]);
  scene.cancelChatSkill();
  gameRig.dispose(); idleRig.dispose();
  assert.equal(player.content.children.length, 0);
  console.info('Split game/idle GLBs, sequence wrap, interruption, mode isolation and movement tracks passed');
}

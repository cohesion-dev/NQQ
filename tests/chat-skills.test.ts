import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { canPerformAction, chatSkills } from '../shared/tools.ts';
import { ChatSkillPlayer } from '../web/src/scene/ChatSkillPlayer.ts';
import { CIRCLE_DURATION_SECONDS, sampleCircleMotion } from '../shared/circle-motion.ts';
import { WalkCycle } from '../web/src/scene/WalkCycle.ts';
import { DANCE_CLIPS, ModelRig, SceneView, toSceneSnapshot } from '../web/src/scene/SceneView.ts';
import { ChatIdleTimer } from '../web/src/scene/ChatIdleTimer.ts';
import { GameEngine } from '../web/src/game/game-engine.ts';

/** 验证模式放行、实际动画变换和完成时机，不依赖显卡或灵矽账号。 */
export async function testChatSkills(): Promise<void> {
  for (const skill of chatSkills) assert.equal(canPerformAction('chat', skill), true);
  assert.equal(canPerformAction('chat', 'stop'), true);
  for (const action of ['left', 'right', 'forward', 'backward', 'unknown']) {
    assert.equal(canPerformAction('chat', action), false);
  }
  for (const action of ['left', 'right', 'forward', 'backward', 'spin', 'somersault', 'stop']) {
    assert.equal(canPerformAction('apple-game', action), true);
  }
  assert.equal(canPerformAction('apple-game', 'dance'), false);

  // 跳过图片解码，只读取真实 GLB 的几何、骨骼和动画进行变换验证。
  const originalSelf = Object.getOwnPropertyDescriptor(globalThis, 'self');
  const originalLoad = THREE.TextureLoader.prototype.load;
  let model: THREE.Group;
  let clips: THREE.AnimationClip[];
  try {
    Object.defineProperty(globalThis, 'self', { configurable: true, value: globalThis });
    /** 用空纹理结束异步加载，让测试无需浏览器图片解码器。 */
    THREE.TextureLoader.prototype.load = function loadTexture(_url, onLoad): THREE.Texture {
      const texture = new THREE.Texture();
      queueMicrotask(() => onLoad?.(texture));
      return texture;
    };
    const bytes = await readFile('assets/niu_qi_qi.glb');
    const gltf = await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
    model = gltf.scene;
    clips = gltf.animations;
  } finally {
    THREE.TextureLoader.prototype.load = originalLoad;
    if (originalSelf) Object.defineProperty(globalThis, 'self', originalSelf);
    else Reflect.deleteProperty(globalThis, 'self');
  }
  let boneCount = 0;
  model.traverse((object) => { if (object instanceof THREE.Bone) boneCount++; });
  assert.equal(boneCount, 34, 'The supplied GLB has 34 bones');
  assert.equal(clips.length, 19);
  assert(clips.every((clip) => clip.duration > 0));
  console.info(`GLB inspected: bones=${boneCount}, clips=${clips.map((clip) => clip.name).join(',')}`);

  let randomValue = 0;
  const rig = new ModelRig(model, clips, () => randomValue);
  const upperLeg = model.getObjectByName('mixamorigLeftUpLeg')!;
  const restUpper = upperLeg.quaternion.clone();
  const hips = model.getObjectByName('mixamorigHips')!;
  const restHips = hips.position.clone();
  const restHipsYaw = new THREE.Euler().setFromQuaternion(hips.quaternion, 'YXZ').y;
  /** 用独立混合器采样原片段，验证应用播放了正确的骨骼姿态。 */
  function clipRotation(name: string, time: number, boneName = upperLeg.name): THREE.Quaternion {
    const reference = model.clone(true);
    const mixer = new THREE.AnimationMixer(reference);
    mixer.clipAction(clips.find((clip) => clip.name === name)!).play();
    mixer.update(time);
    return reference.getObjectByName(boneName)!.quaternion.clone();
  }
  /** 导出四元数存在浮点长度误差，先归一化再比较角度。 */
  function assertRotation(actual: THREE.Quaternion, expected: THREE.Quaternion, message = 'Animation rotations must match'): void {
    assert(actual.clone().normalize().angleTo(expected.clone().normalize()) < 1e-5, message);
  }
  const idle = { x: 0, z: 0, rotation: 0, pose: 'idle', tired: false } as const;
  rig.setSnapshot(idle);
  rig.update(0.2);
  assert(upperLeg.quaternion.angleTo(restUpper) < 1e-6, 'Idle must not play the first Running clip');
  const bounds = new THREE.Box3().setFromObject(rig.group);
  assert(Math.abs(bounds.getSize(new THREE.Vector3()).y - 3.2) < 1e-5, 'The new model keeps the stage height');
  rig.setChatWalking(true);
  rig.update(0.2);
  assert(upperLeg.quaternion.angleTo(restUpper) > 0.1, 'Circling uses the supplied Walking clip');
  assert.equal(hips.position.x, restHips.x, 'Animation cannot override horizontal game movement');
  assert.equal(hips.position.z, restHips.z);
  rig.setChatWalking(false);
  rig.update(0.2);
  assert(upperLeg.quaternion.angleTo(restUpper) < 1e-6, 'Stopping restores the rest pose');
  rig.setSnapshot({ ...idle, pose: 'turn_left', actionProgress: 0.5 });
  rig.update(0.2);
  const expectedTurn = clipRotation('Idle_Turn_Left', clips.find((clip) => clip.name === 'Idle_Turn_Left')!.duration / 2);
  assertRotation(upperLeg.quaternion, expectedTurn, 'Left turn must match the supplied clip');
  assert(Math.abs(new THREE.Euler().setFromQuaternion(hips.quaternion, 'YXZ').y - restHipsYaw) < 1e-5, 'A turn must not apply animated yaw twice');
  rig.setSnapshot({ ...idle, pose: 'turn_right', actionProgress: 0.5 });
  rig.update(0.2);
  assertRotation(upperLeg.quaternion, clipRotation('Idle_Turn_Right', clips.find((clip) => clip.name === 'Idle_Turn_Right')!.duration / 2));
  for (const tired of [false, true, false]) {
    rig.setSnapshot({ ...idle, pose: 'walk', tired });
    rig.update(0.2);
    assertRotation(upperLeg.quaternion, clipRotation(tired ? 'Walking' : 'Running', 0.2), 'Fatigue and recovery switch the actual movement clip');
  }
  rig.setSnapshot({ ...idle, pose: 'spin', rotation: Math.PI * 1.5, actionProgress: 0.5 });
  rig.update(0.2);
  assertRotation(upperLeg.quaternion, clipRotation('Walking', 0.2), 'Game spin must walk rather than run or rotate in place');
  assert.equal(rig.group.rotation.y, Math.PI * 1.5);
  rig.setSnapshot({ ...idle, tired: true });
  rig.update(0.2);
  assert(upperLeg.quaternion.angleTo(restUpper) < 1e-6, 'A tired stationary cow must not walk in place');
  rig.setSnapshot(idle);
  rig.update(0.2);

  const player = new ChatSkillPlayer();
  const normalizedModel = rig.group;
  player.content.add(normalizedModel);
  let completed = false;
  const spin = player.play('spin').then((result) => { completed = true; return result; });
  assert.equal(player.isCircling, true);
  player.update(CIRCLE_DURATION_SECONDS / 2);
  normalizedModel.rotation.y = 0; // 模拟新的基础快照，不得覆盖外层技能。
  player.group.updateMatrixWorld(true);
  const worldRotation = normalizedModel.getWorldQuaternion(new THREE.Quaternion());
  assert(Math.abs(worldRotation.angleTo(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI * 1.5))) < 1e-6);
  assert(Math.abs(player.group.position.x) < 1e-6);
  assert(Math.abs(player.group.position.z + 2) < 1e-6, 'Half a circle reaches the opposite side of its center');
  for (let time = 0.3; time <= 3.9; time += 0.1) {
    const motion = sampleCircleMotion(time);
    assert(Math.abs(Math.hypot(motion.x, motion.z + 1) - 1) < 1e-6, 'The walk stays on a fixed-radius circle');
    const next = sampleCircleMotion(time + 0.00001);
    const dx = next.x - motion.x, dz = next.z - motion.z;
    assert(Math.sin(motion.rotation) * dx + Math.cos(motion.rotation) * dz > 0, 'The cow faces the tangent of its walking path');
  }
  await Promise.resolve();
  assert.equal(completed, false, 'A half spin must not report completion');
  assert.equal((await player.play('somersault')).status, 'rejected', 'Overlapping skills are rejected');
  player.update(CIRCLE_DURATION_SECONDS / 2);
  assert.equal((await spin).status, 'completed');
  assert.equal(player.group.rotation.y, 0, 'A full spin returns to the front');
  assert.equal(player.group.position.x, 0);
  assert.equal(player.group.position.z, 0, 'A full circle returns to its start');
  assert.equal(player.isCircling, false);

  const lowerLeg = model.getObjectByName('mixamorigRightLeg')!;
  const restLower = lowerLeg.quaternion.clone();
  const walk = new WalkCycle(model);
  walk.update(0.1, true);
  assert(upperLeg.quaternion.angleTo(restUpper) > 0.1, 'The supplied GLB upper leg swings during circling');
  assert(lowerLeg.quaternion.angleTo(restLower) > 0.1, 'The supplied GLB knee bends during circling');
  walk.update(0.2, false);
  assert(upperLeg.quaternion.angleTo(restUpper) < 1e-6);
  assert(lowerLeg.quaternion.angleTo(restLower) < 1e-6);

  const flip = player.play('somersault');
  player.update(0.9);
  assert(Math.abs(player.group.rotation.x - Math.PI) < 1e-6, 'The model is upside down halfway through the flip');
  assert(player.group.position.y > 1.6, 'A flip rises above the ground');
  player.update(0.9);
  assert.equal((await flip).status, 'completed');
  assert.equal(player.group.rotation.x, 0);
  assert.equal(player.group.position.y, 1.6);

  const dance = player.play('dance');
  player.update(0.1);
  assert.notEqual(player.group.rotation.z, 0);
  player.cancel();
  assert.equal((await dance).status, 'cancelled');
  player.update(10);
  assert.deepEqual([player.group.rotation.x, player.group.rotation.y, player.group.rotation.z], [0, 0, 0]);
  assert.equal(player.group.position.y, 1.6);

  const retry = player.play('somersault');
  player.update(1.8);
  assert.equal((await retry).status, 'completed', 'Cancellation must allow a new skill');

  // 真实模型片段只能由混合器完成事件结算，不能沿用程序动画的短时长。
  for (let index = 0; index < DANCE_CLIPS.length; index++) {
    randomValue = (index + 0.5) / DANCE_CLIPS.length;
    const playback = rig.prepareChatPlayback('dance')!;
    assert.equal(playback.action.getClip().name, DANCE_CLIPS[index]);
    let ended = false;
    const danceClip = player.play('dance', playback).then((result) => { ended = true; return result; });
    player.update(100);
    rig.update(playback.action.getClip().duration / 2);
    assertRotation(upperLeg.quaternion, clipRotation(DANCE_CLIPS[index], playback.action.getClip().duration / 2));
    rig.setSnapshot(idle);
    await Promise.resolve();
    assert.equal(ended, false, 'Neither fallback timing nor idle snapshots can finish a real clip');
    assert.equal(player.group.rotation.z, 0, 'A real dance must not get a second procedural rotation');
    rig.update(playback.action.getClip().duration / 2 + 0.01);
    assert.equal((await danceClip).status, 'completed');
    assert.equal(player.isPlaying, false);
  }
  const backflipPlayback = rig.prepareChatPlayback('somersault')!;
  assert.equal(backflipPlayback.action.getClip().name, 'Backflip');
  const backflip = player.play('somersault', backflipPlayback);
  rig.update(backflipPlayback.action.getClip().duration / 2);
  assertRotation(hips.quaternion, clipRotation('Backflip', backflipPlayback.action.getClip().duration / 2, hips.name));
  assert.equal(player.group.rotation.x, 0, 'Backflip must not be doubled by the procedural front flip');
  rig.update(backflipPlayback.action.getClip().duration / 2 + 0.01);
  assert.equal((await backflip).status, 'completed');
  assert(upperLeg.quaternion.angleTo(restUpper) < 1e-5);

  const autoDance = player.play('dance', rig.prepareChatPlayback('dance'), true);
  assert.equal(player.isAutomatic, true);
  rig.update(0.1);
  player.cancel();
  assert.equal((await autoDance).status, 'cancelled');
  const nextFlip = player.play('somersault', rig.prepareChatPlayback('somersault'));
  assert.equal(player.isAutomatic, false);
  rig.update(3);
  assert.equal((await nextFlip).status, 'completed', 'Cancelling an automatic dance must allow a manual clip immediately');

  // 复用真实场景方法测试优先级，只跳过需要显卡的舞台构造。
  const scene: SceneView = Object.create(SceneView.prototype);
  Object.assign(scene, {
    mode: 'chat', disposed: false, modelCow: rig, chatSkills: player,
  });
  scene.playIdleDance();
  assert.equal(player.isAutomatic, true);
  const manualFlip = scene.playChatSkill('somersault');
  assert.equal(player.isAutomatic, false, 'A manual skill preempts automatic dancing');
  assert.equal((await scene.playChatSkill('dance')).status, 'rejected', 'A second manual skill cannot steal the active animation');
  scene.cancelIdleDance();
  assert.equal(scene.isChatSkillPlaying, true, 'Conversation only interrupts automatic performances');
  rig.update(3);
  assert.equal((await manualFlip).status, 'completed');

  const idleTimer = new ChatIdleTimer();
  /** 复用页面调度条件，让真实片段结束后间隔半秒重新抽取舞蹈。 */
  function advanceIdle(now: number): void {
    if (idleTimer.update(now, true, false, scene.isChatSkillPlaying, scene.isIdleDancePlaying)) scene.playIdleDance();
  }
  advanceIdle(0);
  advanceIdle(4_999);
  assert.equal(scene.isChatSkillPlaying, false, 'Automatic dancing waits five seconds');
  let idleNow = 5_000;
  for (let index = 0; index < DANCE_CLIPS.length; index++) {
    randomValue = (index + 0.1) / DANCE_CLIPS.length;
    advanceIdle(idleNow);
    assert.equal(scene.isIdleDancePlaying, true, 'A new random dance starts after the half-second interval');
    const duration = clips.find((clip) => clip.name === DANCE_CLIPS[index])!.duration;
    rig.update(duration / 2);
    assertRotation(upperLeg.quaternion, clipRotation(DANCE_CLIPS[index], duration / 2));
    advanceIdle(idleNow + duration * 500);
    assert.equal(scene.isIdleDancePlaying, true, 'An active dance is neither replaced nor restarted');
    rig.update(duration / 2 + 0.01);
    assert.equal(scene.isChatSkillPlaying, false, 'Each real clip finishes before another is selected');
    idleNow += duration * 1_000 + 10;
    advanceIdle(idleNow);
    advanceIdle(idleNow + 499);
    assert.equal(scene.isChatSkillPlaying, false, 'Each completed dance is followed by half a second of rest');
    idleNow += 500;
  }
  advanceIdle(idleNow);
  idleTimer.reset();
  scene.cancelIdleDance();
  assert.equal(scene.isChatSkillPlaying, false, 'Speech cancels an automatic performance immediately');
  assertRotation(upperLeg.quaternion, restUpper);
  advanceIdle(idleNow + 1);
  advanceIdle(idleNow + 5_000);
  assert.equal(scene.isChatSkillPlaying, false, 'Speech resets the five-second wait');
  advanceIdle(idleNow + 5_001);
  assert.equal(scene.isIdleDancePlaying, true);
  scene.cancelIdleDance();
  const cancelledFlip = scene.playChatSkill('somersault');
  scene.cancelChatSkill();
  assert.equal((await cancelledFlip).status, 'cancelled');
  Object.assign(scene, { mode: 'apple-game' });
  scene.playIdleDance();
  assert.equal(scene.isChatSkillPlaying, false, 'Game mode never starts automatic performances');

  rig.setSnapshot({ ...idle, pose: 'somersault', actionProgress: 0.5 });
  rig.update(0.1);
  assertRotation(hips.quaternion, clipRotation('Backflip', clips.find((clip) => clip.name === 'Backflip')!.duration / 2, hips.name));
  rig.setSnapshot(idle);
  rig.update(0.1);

  testChatIdleTimer();
  await testGameAnimationProgress();
}

/** 覆盖五秒启动、半秒间隔、循环跳舞及对话、主动技能和停用的重置。 */
function testChatIdleTimer(): void {
  const timer = new ChatIdleTimer();
  assert.equal(timer.update(0, true, false, false), false);
  assert.equal(timer.update(4_999, true, false, false), false);
  assert.equal(timer.update(5_000, true, false, false), true);
  assert.equal(timer.update(5_001, true, false, true, true), false);
  assert.equal(timer.update(13_200, true, false, false), false);
  assert.equal(timer.update(13_699, true, false, false), false);
  assert.equal(timer.update(13_700, true, false, false), true);
  assert.equal(timer.update(13_701, true, false, true, true), false);
  assert.equal(timer.update(20_000, true, false, false), false);
  assert.equal(timer.update(20_001, true, true, true, true), false);
  assert.equal(timer.update(21_000, true, false, false), false);
  assert.equal(timer.update(25_999, true, false, false), false);
  assert.equal(timer.update(26_000, true, false, false), true);
  assert.equal(timer.update(26_001, true, false, true), false);
  assert.equal(timer.update(30_000, true, false, false), false);
  assert.equal(timer.update(34_999, true, false, false), false);
  assert.equal(timer.update(35_000, true, false, false), true);
  timer.reset();
  assert.equal(timer.update(40_000, true, false, false), false);
  assert.equal(timer.update(45_000, true, false, false), true);
  assert.equal(timer.update(45_001, false, false, true, true), false);
  assert.equal(timer.update(50_000, true, false, false), false);
  assert.equal(timer.update(54_999, true, false, false), false);
  assert.equal(timer.update(55_000, true, false, false), true);
}

/** 从真实游戏时钟验证去程、回正与后退两次转身的进度和最终朝向。 */
async function testGameAnimationProgress(): Promise<void> {
  for (const [action, angle, returnPose] of [['left', -Math.PI / 2, 'turn_right'], ['right', Math.PI / 2, 'turn_left'], ['backward', -Math.PI, 'turn_back']] as const) {
    let now = 0;
    const game = new GameEngine({ now: () => now });
    game.start();
    const actionResult = game.requestAction(action);
    const turnDuration = action === 'backward' ? 600 : 300;
    now = turnDuration / 2;
    game.tick();
    const middle = toSceneSnapshot(game.snapshot()).cow;
    assert.equal(game.snapshot().actionProgress, 0.5);
    assert(Math.abs(middle.rotation - angle / 2) < 1e-6);
    assert.equal(middle.turnSteps, action === 'backward' ? 2 : 1);
    now = turnDuration + 600 + turnDuration / 2;
    game.tick();
    assert.equal(toSceneSnapshot(game.snapshot()).cow.pose, returnPose);
    now = turnDuration * 2 + 600;
    game.tick();
    assert.equal((await actionResult).status, 'completed');
    assert.equal(toSceneSnapshot(game.snapshot()).cow.rotation, 0);
  }
}

"""
用 Blender 程序化生成桌宠模型（带骨骼 + 动作片段），导出为 GLB。

运行（Blender 4.2+ / 5.x）：
  blender -b --factory-startup -P tools/pets/build_pets.py -- public/models/pets [preview_dir]

设计要点
- 所有宠物共用同一套骨骼命名：hips / spine / head / ear_L / ear_R / eye_L / eye_R /
  arm_L / arm_R / leg_L / leg_R / tail，所以一套动作脚本适用于全部形象。
- 所有骨骼都“竖直朝上”、roll=0，局部轴一致：
    X = 左右轴（绕它转 = 前后摆，走路摆腿、点头）
    Y = 竖直轴（绕它转 = 左右转头；沿它平移 = 上下弹跳）
    Z = 前后轴（绕它转 = 侧向抬起 / 歪头）
- 各个部件刚性绑定到一根骨骼（权重 1），不会出现自动权重的拉扯变形。
- 动作片段名与应用里的状态一致：idle / walk / sit / sleep / excited / thinking /
  dance / stretch / look / wave；另有只控制眼睛的 blink，可与其它动作叠加播放。
"""

import math
import os
import sys

import bpy
from mathutils import Vector

ARGV = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
OUT_DIR = os.path.abspath(ARGV[0] if ARGV else "public/models/pets")
PREVIEW_DIR = os.path.abspath(ARGV[1]) if len(ARGV) > 1 and ARGV[1] else None
ONLY = set(ARGV[2].split(",")) if len(ARGV) > 2 and ARGV[2] else None
FPS = 24


# ---------------------------------------------------------------- 工具函数

def hex_rgba(value):
    value = value.lstrip("#")
    r, g, b = (int(value[i : i + 2], 16) / 255 for i in (0, 2, 4))
    # sRGB -> linear，导出后在 three.js 里颜色和设计稿一致
    lin = lambda c: c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    return (lin(r), lin(g), lin(b), 1.0)


_materials = {}


def material(color, roughness=0.55, emission=None, metallic=0.0):
    key = (color, roughness, emission, metallic)
    if key in _materials:
        return _materials[key]
    mat = bpy.data.materials.new(f"m_{color.lstrip('#')}_{len(_materials)}")
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = hex_rgba(color)
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = metallic
    if emission:
        name = "Emission Color" if "Emission Color" in bsdf.inputs else "Emission"
        bsdf.inputs[name].default_value = hex_rgba(emission)
        if "Emission Strength" in bsdf.inputs:
            bsdf.inputs["Emission Strength"].default_value = 1.6
    _materials[key] = mat
    return mat


def add_part(parts, shape, bone, color, loc, scale=(1, 1, 1), rot=(0, 0, 0), **mat_kw):
    """创建一个部件（尚未合并），记录它属于哪根骨骼。"""
    loc = Vector(loc)
    if shape == "sphere":
        bpy.ops.mesh.primitive_uv_sphere_add(segments=28, ring_count=18, radius=1, location=loc)
    elif shape == "cone":
        bpy.ops.mesh.primitive_cone_add(vertices=24, radius1=1, radius2=0, depth=2, location=loc)
    elif shape == "frustum":
        bpy.ops.mesh.primitive_cone_add(vertices=24, radius1=1, radius2=0.55, depth=2, location=loc)
    elif shape == "cylinder":
        bpy.ops.mesh.primitive_cylinder_add(vertices=24, radius=1, depth=2, location=loc)
    elif shape == "cube":
        bpy.ops.mesh.primitive_cube_add(size=2, location=loc)
        bevel = bpy.context.object.modifiers.new("bevel", "BEVEL")
        bevel.width = 0.28
        bevel.segments = 5
        bevel.limit_method = "NONE"
    elif shape == "torus":
        bpy.ops.mesh.primitive_torus_add(major_radius=1, minor_radius=0.25, location=loc)
    elif shape == "ring":
        # 细圆环：用来做帽檐、领口、袖口这类窄边
        bpy.ops.mesh.primitive_torus_add(major_radius=1, minor_radius=0.1, major_segments=40, minor_segments=10, location=loc)
    else:
        raise ValueError(shape)
    obj = bpy.context.object
    obj.scale = scale
    obj.rotation_euler = [math.radians(a) for a in rot]
    obj.data.materials.append(material(color, **mat_kw))
    parts.append((obj, bone))
    return obj


def mirror(parts, shape, bone, color, loc, scale=(1, 1, 1), rot=(0, 0, 0), **kw):
    """左右对称各放一个：bone 里的 {s} 替换成 L / R。角色左侧是 +X。"""
    x, y, z = loc
    rx, ry, rz = rot
    add_part(parts, shape, bone.format(s="L"), color, (x, y, z), scale, (rx, ry, rz), **kw)
    add_part(parts, shape, bone.format(s="R"), color, (-x, y, z), scale, (rx, -ry, -rz), **kw)


# ---------------------------------------------------------------- 骨骼

def build_armature(joints):
    """joints: {bone: (pivot, parent)}；所有骨骼从枢轴点竖直向上 0.12。"""
    data = bpy.data.armatures.new("PetRig")
    rig = bpy.data.objects.new("PetRig", data)
    bpy.context.scene.collection.objects.link(rig)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode="EDIT")
    for name, (pivot, _parent) in joints.items():
        bone = data.edit_bones.new(name)
        bone.head = Vector(pivot)
        bone.tail = Vector(pivot) + Vector((0, 0, 0.12))
        bone.roll = 0
    for name, (_pivot, parent) in joints.items():
        if parent:
            data.edit_bones[name].parent = data.edit_bones[parent]
            data.edit_bones[name].use_connect = False
    bpy.ops.object.mode_set(mode="OBJECT")
    return rig


def bind(parts, rig, name):
    """把部件合并成一个蒙皮网格，每个部件 100% 权重绑到自己的骨骼。"""
    bpy.ops.object.select_all(action="DESELECT")
    for obj, bone in parts:
        bpy.context.view_layer.objects.active = obj
        obj.select_set(True)
        for mod in list(obj.modifiers):
            bpy.ops.object.modifier_apply(modifier=mod.name)
        bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
        bpy.ops.object.shade_smooth()
        group = obj.vertex_groups.new(name=bone)
        group.add([v.index for v in obj.data.vertices], 1.0, "REPLACE")
        obj.select_set(False)
    for obj, _bone in parts:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = parts[0][0]
    bpy.ops.object.join()
    mesh = bpy.context.object
    mesh.name = name
    mesh.data.name = name
    mod = mesh.modifiers.new("Armature", "ARMATURE")
    mod.object = rig
    mesh.parent = rig
    return mesh


# ---------------------------------------------------------------- 动作

def make_actions(rig, height):
    """height：角色大致身高，用来按比例换算弹跳 / 下蹲的位移。"""
    rig.animation_data_create()
    bones = rig.pose.bones
    for pb in bones:
        pb.rotation_mode = "XYZ"
    h = height
    clips = {}

    def clip(name, length, keyfn, bones_used, loc_bones=(), scale_bones=()):
        action = bpy.data.actions.new(name)
        action.use_fake_user = True
        rig.animation_data.action = action
        for pb in bones:
            pb.rotation_euler = (0, 0, 0)
            pb.location = (0, 0, 0)
            pb.scale = (1, 1, 1)
        steps = keyfn.steps if hasattr(keyfn, "steps") else 8
        for i in range(steps + 1):
            frame = 1 + round(length * i / steps)
            phase = (i % steps) / steps  # 末帧 == 首帧，保证循环无缝
            pose = keyfn(phase * 2 * math.pi)
            for b in bones_used:
                rot = pose.get(b, (0, 0, 0))
                bones[b].rotation_euler = rot
                bones[b].keyframe_insert("rotation_euler", frame=frame)
            for b in loc_bones:
                bones[b].location = pose.get(b + ".loc", (0, 0, 0))
                bones[b].keyframe_insert("location", frame=frame)
            for b in scale_bones:
                bones[b].scale = pose.get(b + ".scale", (1, 1, 1))
                bones[b].keyframe_insert("scale", frame=frame)
        clips[name] = action
        return action

    body = ["hips", "spine", "head", "ear_L", "ear_R", "arm_L", "arm_R", "leg_L", "leg_R", "tail"]
    s, c = math.sin, math.cos

    # 待机：呼吸起伏、轻轻歪头、尾巴慢摆、耳朵偶尔抖
    def idle(t):
        return {
            "spine": (0.03 * s(t), 0, 0.015 * s(t)),
            "head": (0.04 * s(t + 0.6), 0.06 * s(t * 0.5), 0.05 * s(t)),
            "ear_L": (0, 0, 0.08 * max(0, s(t * 2)) ** 4),
            "ear_R": (0, 0, -0.04 * s(t)),
            "arm_L": (0.06 * s(t), 0, 0.05 + 0.03 * s(t)),
            "arm_R": (-0.06 * s(t), 0, -0.05 - 0.03 * s(t)),
            "tail": (0.05 * s(t), 0.35 * s(t), 0),
            "hips.loc": (0, 0.012 * h * (1 + s(t)), 0),
        }
    idle.steps = 16
    clip("idle", 72, idle, body, loc_bones=["hips"])

    # 走路：左右腿交替前后摆、手臂反向摆、身体一步一颠
    def walk(t):
        return {
            "leg_L": (0.55 * s(t), 0, 0),
            "leg_R": (-0.55 * s(t), 0, 0),
            "arm_L": (-0.5 * s(t), 0, 0.12),
            "arm_R": (0.5 * s(t), 0, -0.12),
            "spine": (-0.08, 0.08 * s(t), 0.05 * s(t)),
            "head": (0.06 * s(2 * t), -0.06 * s(t), -0.05 * s(t)),
            "ear_L": (0.15 * s(2 * t), 0, 0.05),
            "ear_R": (0.15 * s(2 * t), 0, -0.05),
            "tail": (0.1, 0.4 * s(t), 0),
            "hips.loc": (0, 0.04 * h * abs(s(t)), 0),
        }
    walk.steps = 16
    clip("walk", 20, walk, body, loc_bones=["hips"])

    # 坐下：整体下沉，双腿向前伸，身体后仰，尾巴贴地慢摆
    def sit(t):
        return {
            "leg_L": (-1.35, 0, 0.12),
            "leg_R": (-1.35, 0, -0.12),
            "spine": (0.12 + 0.025 * s(t), 0, 0),
            "head": (-0.1 + 0.03 * s(t), 0.1 * s(t * 0.5), 0.08),
            "arm_L": (-0.35, 0, 0.1),
            "arm_R": (-0.35, 0, -0.1),
            "tail": (1.0, 0.3 * s(t), 0),
            "hips.loc": (0, -0.16 * h, 0),
        }
    sit.steps = 12
    clip("sit", 72, sit, body, loc_bones=["hips"])

    # 睡觉：蜷起来趴着，头低垂，耳朵耷拉，眼睛闭上，慢慢呼吸
    def sleep(t):
        return {
            "hips.loc": (0, -0.2 * h, 0),
            "spine": (0.28 + 0.03 * s(t), 0, 0.1),
            "head": (0.22, 0.25, 0.38 + 0.02 * s(t)),
            "ear_L": (0.5, 0, 0.5),
            "ear_R": (0.5, 0, -0.5),
            "leg_L": (-1.4, 0, 0.2),
            "leg_R": (-1.4, 0, -0.2),
            "arm_L": (-1.0, 0, 0.35),
            "arm_R": (-1.0, 0, -0.35),
            "tail": (1.2, 0.8, 0),
            "eye_L.scale": (1, 0.12, 1),
            "eye_R.scale": (1, 0.12, 1),
        }
    sleep.steps = 12
    clip("sleep", 96, sleep, body, loc_bones=["hips"], scale_bones=["eye_L", "eye_R"])

    # 开心：原地蹦跳，双手举高挥动，耳朵竖起，尾巴快摇
    def excited(t):
        jump = max(0.0, s(t))
        return {
            "hips.loc": (0, 0.2 * h * jump, 0),
            "leg_L": (-0.35 * jump, 0, 0.15 * jump),
            "leg_R": (-0.35 * jump, 0, -0.15 * jump),
            "arm_L": (0, 0, 2.3 + 0.35 * s(2 * t)),
            "arm_R": (0, 0, -2.3 - 0.35 * s(2 * t)),
            "spine": (-0.1 * jump, 0, 0),
            "head": (-0.15 * jump, 0, 0.1 * s(2 * t)),
            "ear_L": (-0.2, 0, -0.1 * jump),
            "ear_R": (-0.2, 0, 0.1 * jump),
            "tail": (-0.2, 0.7 * s(3 * t), 0),
        }
    excited.steps = 16
    clip("excited", 18, excited, body, loc_bones=["hips"])

    # 思考：一只手托下巴，歪头看上方，尾巴慢慢绕
    def thinking(t):
        return {
            "arm_R": (-1.7, 0.4, -0.55),
            "arm_L": (0.1, 0, 0.12),
            "head": (-0.18, 0.15 + 0.05 * s(t), -0.25 + 0.04 * s(t)),
            "spine": (0.03 * s(t), 0, -0.04),
            "ear_L": (0, 0, 0.1),
            "ear_R": (0.2, 0, -0.15),
            "tail": (0.1, 0.25 * s(t), 0),
        }
    thinking.steps = 12
    clip("thinking", 72, thinking, body)

    # 跳舞：扭腰、双臂交替举起、踏步、甩头
    def dance(t):
        return {
            "spine": (0, 0.35 * s(t), 0.22 * s(t)),
            "hips.loc": (0, 0.06 * h * abs(s(2 * t)), 0),
            "arm_L": (0, 0, 1.6 + 1.0 * s(t)),
            "arm_R": (0, 0, -1.6 + 1.0 * s(t)),
            "leg_L": (-0.4 * max(0, s(t)), 0, 0.1),
            "leg_R": (-0.4 * max(0, -s(t)), 0, -0.1),
            "head": (0.12 * s(2 * t), -0.3 * s(t), -0.2 * s(t)),
            "ear_L": (0.2 * s(2 * t), 0, 0.15),
            "ear_R": (0.2 * s(2 * t), 0, -0.15),
            "tail": (0, 0.8 * s(t), 0),
        }
    dance.steps = 16
    clip("dance", 36, dance, body, loc_bones=["hips"])

    # 伸懒腰：双手举过头顶，后仰拉长身体，再放松
    def stretch(t):
        k = 0.5 - 0.5 * c(t)  # 0 -> 1 -> 0
        return {
            "arm_L": (0, 0, 2.9 * k),
            "arm_R": (0, 0, -2.9 * k),
            "spine": (-0.22 * k, 0, 0),
            "head": (-0.35 * k, 0, 0),
            "ear_L": (-0.15 * k, 0, 0),
            "ear_R": (-0.15 * k, 0, 0),
            "hips.loc": (0, 0.05 * h * k, 0),
            "spine.scale": (1 - 0.03 * k, 1 + 0.08 * k, 1 - 0.03 * k),
            "tail": (-0.4 * k, 0, 0),
        }
    stretch.steps = 12
    clip("stretch", 60, stretch, body, loc_bones=["hips"], scale_bones=["spine"])

    # 张望：转头看左、看右，身体跟一点
    def look(t):
        return {
            "head": (-0.05, 0.75 * s(t), 0.08 * s(t)),
            "spine": (0, 0.18 * s(t), 0),
            "ear_L": (0, 0, 0.12 * s(t)),
            "ear_R": (0, 0, 0.12 * s(t)),
            "tail": (0, -0.3 * s(t), 0),
            "arm_L": (0.05, 0, 0.1),
            "arm_R": (0.05, 0, -0.1),
        }
    look.steps = 16
    clip("look", 84, look, body)

    # 挥手：左手抬起左右挥，头跟着歪
    def wave(t):
        return {
            "arm_L": (0, 0, 2.45 + 0.4 * s(t)),
            "arm_R": (0.05, 0, -0.1),
            "head": (0, -0.12, 0.12 + 0.05 * s(t)),
            "spine": (0, 0, 0.05),
            "ear_L": (0, 0, 0.1 * s(t)),
            "tail": (0, 0.5 * s(t), 0),
        }
    wave.steps = 12
    clip("wave", 16, wave, body)

    # 眨眼：只控制眼睛，叠加在其它动作上循环播放（每 4 秒左右眨一次）
    def blink(t):
        phase = t / (2 * math.pi)
        closed = 1.0 if 0.86 < phase < 0.92 else 0.0
        y = 1 - 0.9 * closed
        return {"eye_L.scale": (1, y, 1), "eye_R.scale": (1, y, 1)}
    blink.steps = 50
    clip("blink", 96, blink, [], scale_bones=["eye_L", "eye_R"])

    # 线性插值让循环更稳定（不出现 bezier 过冲）
    for action in clips.values():
        for fc in iter_fcurves(action):
            for kp in fc.keyframe_points:
                kp.interpolation = "BEZIER" if action.name != "blink" else "CONSTANT"
    rig.animation_data.action = clips["idle"]
    return clips


def iter_fcurves(action):
    """兼容 Blender 4.4+ 的分层 Action 和旧版 action.fcurves。"""
    if hasattr(action, "layers") and len(action.layers) > 0:
        for layer in action.layers:
            for strip in layer.strips:
                for bag in getattr(strip, "channelbags", []):
                    for fc in bag.fcurves:
                        yield fc
        return
    for fc in getattr(action, "fcurves", []):
        yield fc


# ---------------------------------------------------------------- 角色设计

def surface(head, x, z, out=0.0):
    """头部椭球表面上 (x, z) 处的正面点（-Y 方向），out>0 往外凸。"""
    (cx, cy, cz), (rx, ry, rz) = head
    k = 1 - ((x - cx) / rx) ** 2 - ((z - cz) / rz) ** 2
    y = cy - ry * math.sqrt(max(0.0, k))
    return (x, y - out, z)


def eyes(parts, head, x, z, r, color="#0B1B33", shine="#FFFFFF"):
    """大眼睛：贴在头部表面并略微凸出，带两个高光点。"""
    ex, ey, ez = surface(head, x, z)
    ey += r * 0.25
    mirror(parts, "sphere", "eye_{s}", color, (ex, ey, ez), (r * 0.9, r * 0.6, r * 1.15), roughness=0.2)
    mirror(parts, "sphere", "eye_{s}", shine, (ex - r * 0.28, ey - r * 0.5, ez + r * 0.42), (r * 0.3,) * 3, roughness=0.1)
    mirror(parts, "sphere", "eye_{s}", shine, (ex + r * 0.3, ey - r * 0.5, ez - r * 0.45), (r * 0.14,) * 3, roughness=0.1)


def blush(parts, head, x, z, r, color="#F49FB0"):
    bx, by, bz = surface(head, x, z)
    mirror(parts, "sphere", "head", color, (bx, by + r * 0.2, bz), (r, r * 0.3, r * 0.6), roughness=0.7)


def fox():
    """橘子：橙色小狐狸，白肚皮、小尖嘴、黑耳尖、蓬松大尾巴。"""
    P = []
    orange, cream, dark = "#F2792B", "#FFF6EA", "#3A2A24"
    head = ((0, -0.02, 0.95), (0.3, 0.27, 0.26))
    joints = {
        "hips": ((0, 0, 0.42), None),
        "spine": ((0, 0, 0.42), "hips"),
        "head": ((0, -0.02, 0.76), "spine"),
        "ear_L": ((0.17, 0.0, 1.13), "head"),
        "ear_R": ((-0.17, 0.0, 1.13), "head"),
        "eye_L": ((0.11, -0.27, 0.98), "head"),
        "eye_R": ((-0.11, -0.27, 0.98), "head"),
        "arm_L": ((0.2, -0.04, 0.62), "spine"),
        "arm_R": ((-0.2, -0.04, 0.62), "spine"),
        "leg_L": ((0.12, 0, 0.3), "hips"),
        "leg_R": ((-0.12, 0, 0.3), "hips"),
        "tail": ((0, 0.22, 0.36), "hips"),
    }
    add_part(P, "sphere", "spine", orange, (0, 0, 0.52), (0.26, 0.23, 0.29))
    add_part(P, "sphere", "spine", cream, (0, -0.11, 0.49), (0.18, 0.14, 0.22))
    add_part(P, "sphere", "head", orange, head[0], head[1])
    # 白色脸颊 + 往前伸的小尖嘴
    mirror(P, "sphere", "head", cream, surface(head, 0.13, 0.88, -0.05), (0.12, 0.08, 0.09))
    add_part(P, "sphere", "head", cream, surface(head, 0, 0.88, 0.0), (0.11, 0.12, 0.08))
    add_part(P, "sphere", "head", dark, surface(head, 0, 0.9, 0.1), (0.035, 0.025, 0.028), roughness=0.2)
    eyes(P, head, 0.12, 0.99, 0.055)
    mirror(P, "cone", "ear_{s}", orange, (0.17, 0.0, 1.23), (0.1, 0.05, 0.13))
    mirror(P, "cone", "ear_{s}", dark, (0.17, 0.0, 1.32), (0.05, 0.03, 0.05))
    mirror(P, "cone", "ear_{s}", cream, (0.17, -0.03, 1.2), (0.055, 0.02, 0.08))
    mirror(P, "sphere", "arm_{s}", orange, (0.23, -0.06, 0.5), (0.06, 0.06, 0.13))
    mirror(P, "sphere", "arm_{s}", dark, (0.24, -0.08, 0.39), (0.055, 0.055, 0.05))
    mirror(P, "sphere", "leg_{s}", orange, (0.13, -0.02, 0.18), (0.08, 0.08, 0.13))
    mirror(P, "sphere", "leg_{s}", dark, (0.13, -0.07, 0.06), (0.08, 0.1, 0.05))
    add_part(P, "sphere", "tail", orange, (0, 0.4, 0.5), (0.14, 0.24, 0.14), (35, 0, 0))
    add_part(P, "sphere", "tail", cream, (0, 0.55, 0.66), (0.1, 0.12, 0.1), (35, 0, 0))
    return P, joints, 1.3


def cat():
    """团子：圆滚滚的奶灰色小猫，粉耳朵粉鼻子，细长尾巴。"""
    P = []
    fur, belly, pink, dark = "#B9C3D4", "#F7F8FA", "#F4A6B8", "#2B3446"
    head = ((0, -0.02, 0.84), (0.33, 0.29, 0.27))
    joints = {
        "hips": ((0, 0, 0.36), None),
        "spine": ((0, 0, 0.36), "hips"),
        "head": ((0, -0.02, 0.64), "spine"),
        "ear_L": ((0.17, 0.0, 1.02), "head"),
        "ear_R": ((-0.17, 0.0, 1.02), "head"),
        "eye_L": ((0.13, -0.28, 0.87), "head"),
        "eye_R": ((-0.13, -0.28, 0.87), "head"),
        "arm_L": ((0.22, -0.06, 0.5), "spine"),
        "arm_R": ((-0.22, -0.06, 0.5), "spine"),
        "leg_L": ((0.13, 0, 0.24), "hips"),
        "leg_R": ((-0.13, 0, 0.24), "hips"),
        "tail": ((0, 0.24, 0.3), "hips"),
    }
    add_part(P, "sphere", "spine", fur, (0, 0, 0.42), (0.3, 0.27, 0.26))
    add_part(P, "sphere", "spine", belly, (0, -0.13, 0.4), (0.2, 0.15, 0.19))
    add_part(P, "sphere", "head", fur, head[0], head[1])
    add_part(P, "sphere", "head", belly, surface(head, 0, 0.77, -0.04), (0.14, 0.08, 0.08))
    add_part(P, "sphere", "head", pink, surface(head, 0, 0.8, 0.02), (0.035, 0.025, 0.025), roughness=0.3)
    blush(P, head, 0.21, 0.78, 0.05)
    eyes(P, head, 0.13, 0.88, 0.06)
    mirror(P, "cone", "ear_{s}", fur, (0.18, 0.0, 1.09), (0.1, 0.07, 0.11), (0, -14, 0))
    mirror(P, "cone", "ear_{s}", pink, (0.18, -0.04, 1.08), (0.06, 0.02, 0.07), (0, -14, 0))
    mirror(P, "sphere", "arm_{s}", fur, (0.24, -0.1, 0.36), (0.07, 0.07, 0.12))
    mirror(P, "sphere", "arm_{s}", belly, (0.25, -0.13, 0.26), (0.06, 0.06, 0.04))
    mirror(P, "sphere", "leg_{s}", fur, (0.14, -0.04, 0.12), (0.09, 0.1, 0.11))
    mirror(P, "sphere", "leg_{s}", belly, (0.14, -0.12, 0.04), (0.07, 0.05, 0.035))
    add_part(P, "cylinder", "tail", fur, (0, 0.38, 0.44), (0.04, 0.04, 0.2), (-30, 0, 0))
    add_part(P, "sphere", "tail", dark, (0, 0.48, 0.62), (0.05, 0.05, 0.06))
    return P, joints, 1.15


def dino():
    """豆芽：圆胖的小恐龙，背上软刺，头顶长了两片小叶子（叶子用耳朵骨骼驱动）。"""
    P = []
    green, belly, leaf, spike = "#6CC36B", "#F2F7D9", "#2E9E5B", "#F6C453"
    head = ((0, -0.06, 0.94), (0.29, 0.29, 0.25))
    joints = {
        "hips": ((0, 0, 0.4), None),
        "spine": ((0, 0, 0.4), "hips"),
        "head": ((0, -0.04, 0.76), "spine"),
        "ear_L": ((0.0, -0.04, 1.17), "head"),
        "ear_R": ((-0.0, -0.04, 1.17), "head"),
        "eye_L": ((0.12, -0.3, 0.98), "head"),
        "eye_R": ((-0.12, -0.3, 0.98), "head"),
        "arm_L": ((0.24, -0.08, 0.58), "spine"),
        "arm_R": ((-0.24, -0.08, 0.58), "spine"),
        "leg_L": ((0.14, 0, 0.28), "hips"),
        "leg_R": ((-0.14, 0, 0.28), "hips"),
        "tail": ((0, 0.22, 0.32), "hips"),
    }
    add_part(P, "sphere", "spine", green, (0, 0, 0.5), (0.3, 0.27, 0.32))
    add_part(P, "sphere", "spine", belly, (0, -0.14, 0.47), (0.21, 0.14, 0.25))
    for i, z in enumerate((0.74, 0.6, 0.46)):
        add_part(P, "cone", "spine", spike, (0, 0.25 + i * 0.03, z), (0.05, 0.05, 0.06), (-70, 0, 0), roughness=0.4)
    add_part(P, "sphere", "head", green, head[0], head[1])
    add_part(P, "sphere", "head", belly, surface(head, 0, 0.85, -0.05), (0.15, 0.08, 0.08))
    mirror(P, "sphere", "head", "#235A3A", surface(head, 0.05, 0.88, 0.0), (0.014, 0.01, 0.01))
    blush(P, head, 0.2, 0.86, 0.045)
    eyes(P, head, 0.12, 0.99, 0.058)
    add_part(P, "cylinder", "ear_L", leaf, (0.0, -0.04, 1.2), (0.012, 0.012, 0.05))
    add_part(P, "sphere", "ear_L", leaf, (0.07, -0.04, 1.27), (0.075, 0.022, 0.035), (0, -30, 0), roughness=0.45)
    add_part(P, "sphere", "ear_R", leaf, (-0.06, -0.04, 1.25), (0.06, 0.02, 0.03), (0, 35, 0), roughness=0.45)
    mirror(P, "sphere", "arm_{s}", green, (0.27, -0.12, 0.48), (0.055, 0.055, 0.1), (20, 0, 0))
    mirror(P, "sphere", "leg_{s}", green, (0.15, -0.02, 0.16), (0.1, 0.11, 0.14))
    mirror(P, "sphere", "leg_{s}", belly, (0.15, -0.11, 0.05), (0.07, 0.05, 0.03))
    add_part(P, "cone", "tail", green, (0, 0.42, 0.26), (0.15, 0.15, 0.24), (-75, 0, 0))
    add_part(P, "cone", "tail", spike, (0, 0.5, 0.36), (0.035, 0.035, 0.045), (-60, 0, 0), roughness=0.4)
    return P, joints, 1.25


def robot():
    """小柚：青色小机器人，深蓝面罩 + 发光眼睛，橙色天线球。"""
    P = []
    body, visor, glow, metal, accent = "#00B2A9", "#041E42", "#7CF5EE", "#8D99AE", "#FC7A1E"
    joints = {
        "hips": ((0, 0, 0.36), None),
        "spine": ((0, 0, 0.36), "hips"),
        "head": ((0, 0, 0.7), "spine"),
        "ear_L": ((0.0, 0.02, 1.1), "head"),
        "ear_R": ((-0.31, 0.0, 0.92), "head"),
        "eye_L": ((0.1, -0.3, 0.9), "head"),
        "eye_R": ((-0.1, -0.3, 0.9), "head"),
        "arm_L": ((0.27, 0, 0.56), "spine"),
        "arm_R": ((-0.27, 0, 0.56), "spine"),
        "leg_L": ((0.12, 0, 0.24), "hips"),
        "leg_R": ((-0.12, 0, 0.24), "hips"),
        "tail": ((0, 0.24, 0.42), "hips"),
    }
    add_part(P, "cube", "spine", body, (0, 0, 0.47), (0.24, 0.2, 0.22), roughness=0.35)
    add_part(P, "sphere", "spine", accent, (0, -0.2, 0.5), (0.05, 0.02, 0.05), emission="#FC7A1E", roughness=0.3)
    add_part(P, "cube", "head", body, (0, -0.02, 0.89), (0.3, 0.25, 0.22), roughness=0.35)
    add_part(P, "cube", "head", visor, (0, -0.21, 0.88), (0.24, 0.08, 0.15), roughness=0.15)
    mirror(P, "cylinder", "head", metal, (0.31, 0, 0.9), (0.06, 0.06, 0.03), (0, 90, 0), metallic=0.6, roughness=0.3)
    add_part(P, "cylinder", "ear_L", metal, (0, 0.02, 1.17), (0.013, 0.013, 0.08), metallic=0.6, roughness=0.3)
    add_part(P, "sphere", "ear_L", accent, (0, 0.02, 1.27), (0.05, 0.05, 0.05), emission="#FC7A1E", roughness=0.3)
    mirror(P, "sphere", "eye_{s}", glow, (0.1, -0.29, 0.9), (0.055, 0.02, 0.06), emission="#7CF5EE", roughness=0.2)
    mirror(P, "cylinder", "arm_{s}", metal, (0.3, 0, 0.45), (0.035, 0.035, 0.1), metallic=0.6, roughness=0.3)
    mirror(P, "sphere", "arm_{s}", body, (0.3, 0, 0.33), (0.065, 0.065, 0.065), roughness=0.35)
    mirror(P, "cylinder", "leg_{s}", metal, (0.12, 0, 0.17), (0.04, 0.04, 0.08), metallic=0.6, roughness=0.3)
    mirror(P, "cube", "leg_{s}", visor, (0.12, -0.03, 0.05), (0.08, 0.11, 0.05), roughness=0.3)
    add_part(P, "cylinder", "tail", metal, (0, 0.27, 0.42), (0.03, 0.03, 0.06), (90, 0, 0), metallic=0.6, roughness=0.3)
    add_part(P, "torus", "tail", accent, (0, 0.34, 0.42), (0.06, 0.06, 0.06), (90, 0, 0), roughness=0.4)
    return P, joints, 1.25


def penguin():
    """布丁：深蓝小企鹅，白脸白肚皮，橙色小嘴和脚，小鳍当手。"""
    P = []
    navy, white, orange = "#1C2E4A", "#F7F8FA", "#FC9A3A"
    head = ((0, 0, 0.88), (0.26, 0.24, 0.22))
    face = ((0, -0.08, 0.86), (0.2, 0.17, 0.16))
    joints = {
        "hips": ((0, 0, 0.3), None),
        "spine": ((0, 0, 0.3), "hips"),
        "head": ((0, 0, 0.72), "spine"),
        "ear_L": ((0.0, 0.0, 1.08), "head"),
        "ear_R": ((0.0, 0.05, 1.0), "head"),
        "eye_L": ((0.09, -0.24, 0.9), "head"),
        "eye_R": ((-0.09, -0.24, 0.9), "head"),
        "arm_L": ((0.28, 0, 0.6), "spine"),
        "arm_R": ((-0.28, 0, 0.6), "spine"),
        "leg_L": ((0.1, 0, 0.12), "hips"),
        "leg_R": ((-0.1, 0, 0.12), "hips"),
        "tail": ((0, 0.24, 0.18), "hips"),
    }
    add_part(P, "sphere", "spine", navy, (0, 0, 0.46), (0.3, 0.27, 0.36))
    add_part(P, "sphere", "spine", white, (0, -0.1, 0.43), (0.23, 0.2, 0.3))
    add_part(P, "sphere", "head", navy, head[0], head[1])
    add_part(P, "sphere", "head", white, face[0], face[1])
    add_part(P, "cone", "head", orange, surface(face, 0, 0.83, 0.03), (0.045, 0.045, 0.06), (90, 0, 0), roughness=0.35)
    blush(P, face, 0.13, 0.81, 0.04)
    eyes(P, face, 0.09, 0.91, 0.045)
    add_part(P, "sphere", "ear_L", navy, (0.0, 0.0, 1.12), (0.05, 0.05, 0.05))
    add_part(P, "sphere", "ear_R", navy, (0.0, 0.05, 1.02), (0.001, 0.001, 0.001))
    mirror(P, "sphere", "arm_{s}", navy, (0.31, 0, 0.46), (0.05, 0.1, 0.17), (0, 0, -12))
    mirror(P, "sphere", "leg_{s}", orange, (0.1, -0.08, 0.07), (0.08, 0.11, 0.035), roughness=0.4)
    add_part(P, "cone", "tail", navy, (0, 0.27, 0.14), (0.08, 0.08, 0.08), (-110, 0, 0))
    return P, joints, 1.15


CHARACTERS = {
    "fox": fox,
    "cat": cat,
    "dino": dino,
    "robot": robot,
    "penguin": penguin,
}


# ---------------------------------------------------------------- 预览渲染

def setup_render_scene():
    """渲染用的相机、灯光和透明背景（预览图与头像共用）。"""
    scene = bpy.context.scene
    engines = [e.identifier for e in bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items]
    scene.render.engine = "BLENDER_EEVEE_NEXT" if "BLENDER_EEVEE_NEXT" in engines else "BLENDER_EEVEE"
    scene.render.film_transparent = True
    cam_data = bpy.data.cameras.new("cam")
    cam_data.lens = 60
    cam = bpy.data.objects.new("cam", cam_data)
    scene.collection.objects.link(cam)
    scene.camera = cam
    sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN"))
    sun.data.energy = 3.2
    sun.rotation_euler = (math.radians(50), math.radians(10), math.radians(25))
    scene.collection.objects.link(sun)
    world = bpy.data.worlds.new("w")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs[1].default_value = 0.9
    scene.world = world
    return scene, cam


def aim(cam, location, target):
    cam.location = location
    cam.rotation_euler = (Vector(target) - Vector(location)).to_track_quat("-Z", "Y").to_euler()


def render_thumbnail(name, clips, out_dir):
    """头像：待机姿态的正面半身照，供 Bot 头像、形态列表使用。"""
    scene, cam = setup_render_scene()
    scene.render.resolution_x = 192
    scene.render.resolution_y = 192
    rig = bpy.data.objects["PetRig"]
    rig.animation_data.action = clips["idle"]
    scene.frame_set(1)
    aim(cam, (0.35, -2.4, 1.05), (0, 0, 0.8))
    cam.data.lens = 62
    os.makedirs(out_dir, exist_ok=True)
    scene.render.filepath = os.path.join(out_dir, f"{name}.png")
    bpy.ops.render.render(write_still=True)


def render_previews(name, clips):
    if not PREVIEW_DIR:
        return
    os.makedirs(PREVIEW_DIR, exist_ok=True)
    scene, cam = setup_render_scene()
    scene.render.resolution_x = 360
    scene.render.resolution_y = 360
    aim(cam, (0.7, -3.6, 1.2), (0, 0, 0.62))
    rig = bpy.data.objects["PetRig"]
    for clip_name, frame_frac in [("idle", 0.0), ("walk", 0.25), ("wave", 0.25), ("sleep", 0.0), ("dance", 0.25), ("thinking", 0.0), ("excited", 0.25), ("sit", 0.0)]:
        action = clips[clip_name]
        rig.animation_data.action = action
        start, end = action.frame_range
        scene.frame_set(int(start + (end - start) * frame_frac))
        scene.render.filepath = os.path.join(PREVIEW_DIR, f"{name}_{clip_name}.png")
        bpy.ops.render.render(write_still=True)
    rig.animation_data.action = clips["idle"]


# ---------------------------------------------------------------- 主流程

def build(name, factory, custom=False):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    _materials.clear()
    bpy.context.scene.render.fps = FPS
    parts, joints, height = factory()
    rig = build_armature(joints)
    bind(parts, rig, f"{name}_mesh")
    clips = make_actions(rig, height)
    out_dir = os.path.join(OUT_DIR, "custom") if custom else OUT_DIR
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, f"{name}.glb")
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB",
        export_animations=True,
        export_animation_mode="ACTIONS",
        export_skins=True,
        export_morph=False,
        export_yup=True,
        export_lights=False,
        export_cameras=False,
    )
    print(f"[pets] exported {path} ({os.path.getsize(path) // 1024} KB, {len(clips)} clips)")
    render_thumbnail(name, clips, os.path.join(out_dir, "thumbs"))
    render_previews(name, clips)


# 私人定制形象（例如照着家人照片做的）放在 tools/pets/custom_pets.py，
# 输出到 public/models/pets/custom/，两者都在 .gitignore 里，不会被提交。
CUSTOM = {}
_custom_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "custom_pets.py")
if os.path.exists(_custom_path):
    _scope = {"__name__": "custom_pets", "add_part": add_part, "mirror": mirror, "eyes": eyes,
              "blush": blush, "surface": surface, "math": math}
    exec(compile(open(_custom_path, encoding="utf-8").read(), _custom_path, "exec"), _scope)
    CUSTOM = _scope.get("CHARACTERS", {})
    CUSTOM_LABELS = _scope.get("LABELS", {})
else:
    CUSTOM_LABELS = {}


def write_custom_manifest():
    """应用通过 public/models/pets/custom/manifest.json 发现本机的私人形象。"""
    import json
    folder = os.path.join(OUT_DIR, "custom")
    if not os.path.isdir(folder):
        return
    entries = []
    for file in sorted(os.listdir(folder)):
        if file.endswith(".glb"):
            pid = file[:-4]
            label, desc = CUSTOM_LABELS.get(pid, (pid, ""))
            entries.append({"id": pid, "label": label, "description": desc})
    with open(os.path.join(folder, "manifest.json"), "w", encoding="utf-8") as fh:
        json.dump(entries, fh, ensure_ascii=False, indent=2)

for char_name, char_factory in list(CHARACTERS.items()) + list(CUSTOM.items()):
    if ONLY and char_name not in ONLY:
        continue
    build(char_name, char_factory, custom=char_name in CUSTOM)

write_custom_manifest()

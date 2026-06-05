import { create } from "zustand";

type Emotion = "idle" | "thinking" | "excited" | "sleepy" | "happy";

interface PetState {
  emotion: Emotion;
  name: string;
  setEmotion: (e: Emotion) => void;
  setName: (n: string) => void;
}

export const usePetStore = create<PetState>((set) => ({
  emotion: "idle",
  name: "皮卡丘",
  setEmotion: (emotion) => set({ emotion }),
  setName: (name) => set({ name }),
}));

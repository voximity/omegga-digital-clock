import OmeggaPlugin, {
  OL,
  PS,
  PC,
  Vector,
  BrsV10,
  BrickV10,
  WriteSaveObject,
  IBrickBounds,
  UnrealColor,
} from 'omegga';
import fs from 'fs';

const {
  getBounds,
  d2o,
  BRICK_CONSTANTS: { translationTable, orientationMap },
} = OMEGGA_UTIL.brick;
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

type Config = {
  ['clock-behavior']: 'countdown' | 'countup' | 'time';
  ['clock-authorized']: string[];
  ['clock-timestamp']: number;
  ['clock-include-days']: boolean;
  ['clock-material']: string;
  ['clock-color']: string;
  ['clock-colon-blink']: boolean;
  ['clock-update-seconds']: number;
  ['clock-12h']: boolean;
};

type Storage = {
  uuid: string;
  clockPos?: { location: Vector; orientation: string };
};

type Region = { center: Vector; extent: Vector };

function mergeRegions(...regions: Region[]): Region {
  const min = [Number.MAX_VALUE, Number.MAX_VALUE, Number.MAX_VALUE];
  const max = [Number.MIN_VALUE, Number.MIN_VALUE, Number.MIN_VALUE];

  for (const region of regions) {
    if (!region) continue;
    const {
      center: [cx, cy, cz],
      extent: [ex, ey, ez],
    } = region;

    const rmin = [cx - ex, cy - ey, cz - ez];
    const rmax = [cx + ex, cy + ey, cz + ez];

    if (rmin[0] < min[0]) min[0] = rmin[0];
    if (rmin[1] < min[1]) min[1] = rmin[1];
    if (rmin[2] < min[2]) min[2] = rmin[2];

    if (rmax[0] < max[0]) max[0] = rmax[0];
    if (rmax[1] < max[1]) max[1] = rmax[1];
    if (rmax[2] < max[2]) min[2] = rmax[2];
  }

  if (min[0] > max[0] || min[1] > max[1] || min[2] > max[2]) {
    throw 'no_regions';
  }

  const center = max.map((c, i) => (c + min[i]) / 2) as Vector;

  return {
    center,
    extent: max.map((c, i) => c - center[i]) as Vector,
  };
}

function boundToRegion(bound: IBrickBounds): Region {
  return {
    center: bound.center,
    extent: bound.maxBound.map((c, i) => c - bound.center[i]) as Vector,
  };
}

export const SEGMENTS: Record<string, number> = {
  '0': 0b1111011,
  '1': 0b1001000,
  '2': 0b0111101,
  '3': 0b1101101,
  '4': 0b1001110,
  '5': 0b1100111,
  '6': 0b1110111,
  '7': 0b1001001,
  '8': 0b1111111,
  '9': 0b1101111,
  A: 0b1011111,
  B: 0b1110110,
  C: 0b0110011,
  D: 0b1111100,
  E: 0b0110111,
  F: 0b0010111,
  G: 0b1110011,
  H: 0b1011110,
  I: 0b0010010,
  J: 0b1111000,
  K: 0b1011110, // same as H :(
  L: 0b0110010,
  M: 0b1011011, // same as N :(
  N: 0b1011011,
  O: 0b1111011,
  P: 0b0011111,
  Q: 0b1001111,
  R: 0b0010100,
  S: 0b1100111,
  T: 0b0110110,
  U: 0b1111010,
  V: 0b1110000,
  W: 0b1111010, // same as U :(
  X: 0b1011110, // same as H :(
  Y: 0b1101110,
  Z: 0b0111101,
  ' ': 0,
};

const importAsset = (
  path: string,
  isDigit?: boolean
): [BrsV10, BrickV10[][]] => {
  const save = OMEGGA_UTIL.brs.read(fs.readFileSync(path));
  if (save.version !== 10) throw 'bad_save_ver';

  const bounds = OMEGGA_UTIL.brick.getBounds(save);
  for (const brick of save.bricks) {
    brick.position = brick.position.map(
      (c, i) => c - bounds.center[i]
    ) as Vector;

    brick.owner_index = 0;
  }

  const digit_bricks: BrickV10[][] = [];
  if (isDigit) {
    for (let i = 0; i < 7; i++) {
      digit_bricks.push(save.bricks.filter((b) => b.color === i));
    }
  }

  return [save, digit_bricks];
};

export const [DIGIT_SAVE, DIGIT_BRICKS] = importAsset(
  'plugins/ny22/assets/digit.brs',
  true
);
export const [COLON_SAVE] = importAsset('plugins/ny22/assets/colon.brs');

COLON_SAVE.bricks.forEach(
  (b) =>
    (b.asset_name_index = DIGIT_SAVE.brick_assets.indexOf(
      COLON_SAVE.brick_assets[b.asset_name_index]
    ))
);

export default class Plugin implements OmeggaPlugin<Config, Storage> {
  omegga: OL;
  config: PC<Config>;
  store: PS<Storage>;
  uuid: string;
  clockPos?: Storage['clockPos'];

  overrideContents: boolean = false;
  current: string = '';
  currentRegions: Region[] = [];
  alternation: boolean[] = [];
  startTime: number = Date.now() / 1000;

  promises: Record<string, (data?: string) => void> = {};

  constructor(omegga: OL, config: PC<Config>, store: PS<Storage>) {
    this.omegga = omegga;
    this.config = config;
    this.store = store;
  }

  waitForUser = (user: string) => {
    if (user in this.promises) return;
    return new Promise<string | undefined>((resolve, reject) => {
      const timeout = setTimeout(() => {
        delete this.promises[user];
        reject('timed_out');
      }, 30_000);

      this.promises[user] = (data?: string) => {
        clearTimeout(timeout);
        delete this.promises[user];
        resolve(data);
      };
    });
  };

  getAlternation = (n: number) => {
    const a = Number(this.alternation[n]);
    return isNaN(a) ? 0 : a;
  };

  digitFromLetter = (
    letter: string,
    props?: Partial<BrickV10>,
    offset?: Vector
  ): BrickV10[] => {
    if (!(letter in SEGMENTS)) throw 'no_letter';
    const flag = SEGMENTS[letter];
    const bricks = [];

    for (let i = 0; i < 7; i++) {
      if (flag & (1 << i)) {
        for (const ref of DIGIT_BRICKS[i]) {
          const brick = { ...ref, ...(props ?? {}) };
          if (offset) {
            brick.position = brick.position.map(
              (c, i) => c + offset[i]
            ) as Vector;
          }
          bricks.push(brick);
        }
      }
    }

    return bricks;
  };

  loadBricks = async (data: WriteSaveObject) => {
    if (!data.bricks.length) return;

    const orientation =
      OMEGGA_UTIL.brick.BRICK_CONSTANTS.orientationMap[
        this.clockPos.orientation
      ];

    data.brick_owners = [{ id: this.uuid, name: 'Digital clock' }];
    for (let i = 0; i < data.bricks.length; i++) {
      data.bricks[i] = OMEGGA_UTIL.brick.rotate(data.bricks[i], orientation);
      data.bricks[i].owner_index = 1;
    }

    await Omegga.loadSaveData(data, {
      quiet: true,
      offX: this.clockPos.location[0],
      offY: this.clockPos.location[1],
      offZ: this.clockPos.location[2],
    });
  };

  regionToWorldSpace = (region: Region): Region => {
    const rotation = orientationMap[this.clockPos.orientation];
    const [cx, cy, cz] = this.clockPos.location;
    const [rrx, rry, rrz] = translationTable[d2o(...rotation)](region.center);

    return {
      center: [cx + rrx, cy + rry, cz + rrz],
      extent: translationTable[d2o(...rotation)](region.extent).map(
        Math.abs
      ) as Vector,
    };
  };

  loadString = async (str: string) => {
    const bricks = [];
    const off: Vector = [0, 0, 0];
    const deleteRegions: Region[] = [];
    const regions: Region[] = [...this.currentRegions];

    let i = 0;
    for (; i < str.length; i++) {
      const unchanged = this.current[i] === str[i];
      const loff: Vector = [0, 0, 0];

      // if the digit changed...
      if (!unchanged) {
        // add the current alternation to be deleted
        if (this.currentRegions[i]) {
          deleteRegions.push(this.currentRegions[i]);
        }

        // invert the alternation
        this.alternation[i] = !this.alternation[i];

        // adjust the local offset based on the alternation
        loff[0] = -this.getAlternation(i) * 4;
      }

      if (str[i] === ':') {
        // a colon
        off[1] -= 25;

        if (!unchanged) {
          const colon = COLON_SAVE.bricks.map((src) => {
            return {
              ...src,
              position: src.position.map(
                (c, i) => c + off[i] + loff[i]
              ) as Vector,
              color: 0,
              material_index: 0,
              owner_index: 1,
            };
          });

          colon.forEach((b) => bricks.push(b));
          regions[i] = this.regionToWorldSpace(
            boundToRegion(getBounds({ ...COLON_SAVE, bricks: colon }))
          );
        }

        off[1] += 65;
      } else if (str[i] === ';') {
        // a blank colon
        off[1] += 40;
        regions[i] = null;
      } else if (str[i] === ' ') {
        // a space
        off[1] += 90;
        regions[i] = null;
      } else {
        if (!unchanged) {
          const digit = this.digitFromLetter(
            str[i].toUpperCase(),
            {
              color: 0,
              material_index: 0,
            },
            off.map((c, i) => c + loff[i]) as Vector
          );

          digit.forEach((b) => bricks.push(b));
          regions[i] = this.regionToWorldSpace(
            boundToRegion(getBounds({ ...DIGIT_SAVE, bricks: digit }))
          );
        }

        off[1] += 90;
      }
    }

    // clean up extra chars
    if (i < this.current.length) {
      try {
        const region = mergeRegions(...this.currentRegions.slice(i));
        this.omegga.clearRegion(region);
      } catch (_) {
        // ...
      }
    }

    this.current = str;
    this.currentRegions = regions;

    const save = {
      ...DIGIT_SAVE,
      materials: [this.config['clock-material'] ?? 'BMC_Glow'],
      colors: [
        this.config['clock-color']
          ? ([
              ...this.config['clock-color'].split(',').map(Number),
              255,
            ] as UnrealColor)
          : [255, 255, 255, 255],
      ],
      bricks,
    } as WriteSaveObject;

    await this.loadBricks(save);

    for (const region of deleteRegions) {
      this.omegga.clearRegion(region);
    }
  };

  marquee = async (text: string) => {
    if (this.overrideContents) throw 'already_active';
    this.overrideContents = true;
    const limit = this.config['clock-include-days'] ? 8 : 6;

    const displaySlice = async (slice: string) => {
      let s = '';
      for (let i = 0; i < limit; i++) {
        s += slice[i] ?? ' ';
        if (i % 2 === 1) s += ';';
      }
      await this.loadString(s.replace(/;$/, ''));
    };

    if (text.length <= limit) {
      displaySlice(text);
      await sleep(5000);
      this.overrideContents = false;
    } else {
      displaySlice(text.slice(0, limit));
      await sleep(2000);
      for (let i = 0; i < text.length; i++) {
        displaySlice(text.slice(i, i + limit));
        await sleep(500);
      }
      for (let i = 0; i < limit; i++) {
        displaySlice(text.slice(0, i + 1).padStart(limit));
        await sleep(500);
      }
      await sleep(500);
      this.overrideContents = false;
    }
  };

  clearColons = () => {
    for (let i = 0; i < this.current.length; i++) {
      if (this.current.substring(i, i + 1) === ':') {
        this.omegga.clearRegion(this.currentRegions[i]);
      }
    }
    this.current = this.current.replace(/:/g, ';');
  };

  update = async () => {
    if (this.overrideContents) return;

    const days = this.config['clock-include-days'] ?? false;

    let t: number;
    switch (this.config['clock-behavior']) {
      case 'countdown':
        t = Math.round(
          Math.max(0, this.config['clock-timestamp'] - Date.now() / 1000)
        );
        break;
      case 'countup':
        t = Math.round(Math.max(0, Date.now() / 1000 - this.startTime));
        break;
      case 'time':
        const midnight = new Date();
        midnight.setHours(0, 0, 0, 0);
        t = Math.round((new Date().getTime() - midnight.getTime()) / 1000);
        if (this.config['clock-12h']) t %= 43200;
        break;
      default:
        t = 0;
        break;
    }

    const dd = Math.floor((t / 86400) % 99);
    const hh = Math.floor(
      (t / 3600) %
        (days || this.config['clock-behavior'] === 'countdown' ? 24 : 99)
    );
    const mm = Math.floor((t / 60) % 60);
    const ss = t % 60;

    if (t > 0) {
      const str = (days ? [dd, hh, mm, ss] : [hh, mm, ss])
        .map((s) => s.toString().padStart(2, '0'))
        .join(':');
      await this.loadString(str);

      if (this.config['clock-colon-blink'])
        setTimeout(() => this.clearColons(), 500);
    } else {
      const str =
        Math.round(Date.now() / 1000) % 2 === 0
          ? (days ? [0, 0, 0, 0] : [0, 0, 0])
              .map((s) => s.toString().padStart(2, '0'))
              .join(':')
          : (days ? ['  ', '  ', '  ', '  '] : ['  ', '  ', '  ']).join(':');
      await this.loadString(str);
    }
  };

  async init() {
    const uuid = await this.store.get('uuid');
    if (!uuid) {
      this.uuid = OMEGGA_UTIL.uuid.random();
      await this.store.set('uuid', this.uuid);
    } else this.uuid = uuid;

    this.omegga.clearBricks(this.uuid, true);

    const pos = await this.store.get('clockPos');
    if (pos) {
      this.clockPos = pos;
      setInterval(async () => {
        try {
          await this.update();
        } catch (e) {
          console.error('Update error:', e);
        }
      }, (this.config['clock-update-seconds'] ?? 1) * 1000);
    }

    this.omegga.on(
      'cmd:clock',
      async (speaker: string, action: string, ...args: string[]) => {
        const player = Omegga.getPlayer(speaker);
        if (
          !player.isHost() &&
          !player
            .getRoles()
            .some((r) => (this.config['clock-authorized'] ?? []).includes(r))
        )
          return;

        try {
          if (action === 'setpos') {
            // set the clock's position

            // load the digit onto the player's clipboard
            player.loadSaveData(DIGIT_SAVE);
            Omegga.whisper(
              player,
              `Move the copied digit to the first digit on the clock.`
            );
            Omegga.whisper(
              player,
              `When you are satisfied, run <code>/clock ok</>.`
            );
            await this.waitForUser(speaker);

            const ghost = await player.getGhostBrick();
            this.current = '';

            this.clockPos = {
              location: ghost.location as Vector,
              orientation: ghost.orientation,
            };
            await this.store.set('clockPos', this.clockPos);
            Omegga.whisper(player, 'Clock position set.');
          } else if (action === 'marquee') {
            await this.marquee(args.join(' '));
          } else if (action === 'clear') {
            this.current = '';
            for (const owner of DIGIT_SAVE.brick_owners)
              Omegga.clearBricks(owner.id, true);
          } else if (action === 'ok') {
            if (speaker in this.promises)
              this.promises[speaker](
                args.length > 0 ? args.join(' ') : undefined
              );
          } else {
            Omegga.whisper(
              player,
              'Unknown clock action <code>' + action + '</>.'
            );
          }
        } catch (e) {
          console.error('error', e);
        }
      }
    );

    return { registeredCommands: ['clock'] };
  }

  async stop() {}
}

import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  isPathInside, parseEpicManifest, parseGogRegistry, parseMicrosoftGameConfig,
  parseSteamAppManifest, parseSteamLibraryFolders, parseGamingRoot,
} from './gameCatalog';

describe('game platform catalog parsers', () => {
  it('parses Steam libraries and manifests', () => {
    expect(parseSteamLibraryFolders('"path" "D:\\\\SteamLibrary"')).toEqual(['D:\\SteamLibrary']);
    expect(parseSteamAppManifest('"appid" "883710"\n"name" "Resident Evil 2"\n"installdir" "RESIDENT EVIL 2"', 'D:\\SteamLibrary\\steamapps')).toEqual({
      id: 'steam:883710', name: 'Resident Evil 2',
      installDir: path.win32.join('D:\\SteamLibrary\\steamapps', 'common', 'RESIDENT EVIL 2'), platform: 'steam',
    });
    expect(parseSteamAppManifest('"appid" "1"\n"name" "Game"\n"installdir" "Game"\n"clienticon" "abc"', 'D:\\Steam\\steamapps')?.iconPath)
      .toBe('D:\\Steam\\steam\\games\\abc.ico');
  });

  it('parses Epic, GOG, and Xbox metadata', () => {
    expect(parseEpicManifest(JSON.stringify({ InstallLocation: 'D:\\Epic\\Game', DisplayName: 'Game', CatalogItemId: 'catalog' })))
      .toMatchObject({ id: 'epic:catalog', name: 'Game', platform: 'epic' });
    expect(parseEpicManifest(JSON.stringify({
      InstallLocation: 'D:\\Epic\\Game', DisplayName: 'Game', CatalogItemId: 'catalog', LaunchExecutable: 'Game.exe',
    }))?.iconPath).toBe('D:\\Epic\\Game\\Game.exe');
    expect(parseGogRegistry('HKEY_LOCAL_MACHINE\\SOFTWARE\\GOG.com\\Games\\42\n gameName REG_SZ GOG Game\n path REG_SZ D:\\GOG\\Game'))
      .toEqual([{ id: 'gog:42', name: 'GOG Game', installDir: 'D:\\GOG\\Game', platform: 'gog' }]);
    expect(parseMicrosoftGameConfig('<Game><Identity Name="xbox-id"/><ShellVisuals DefaultDisplayName="Xbox Game"/></Game>', 'E:\\XboxGames\\Game\\Content'))
      .toEqual({ id: 'xbox:xbox-id', name: 'Xbox Game', installDir: 'E:\\XboxGames\\Game\\Content', platform: 'xbox' });
  });

  it('matches executable paths on directory boundaries', () => {
    expect(isPathInside('D:\\Games\\Demo\\bin\\game.exe', 'D:\\Games\\Demo')).toBe(true);
    expect(isPathInside('D:\\Games\\Demo2\\game.exe', 'D:\\Games\\Demo')).toBe(false);
  });

  it('decodes an Xbox .GamingRoot path', () => {
    expect(parseGamingRoot(Buffer.concat([Buffer.from('RGBX'), Buffer.from('Games\\Xbox\0', 'utf16le')]))).toBe('Games\\Xbox');
  });
});

// Editing math and selectors, independent of the DOM and storage.
export const clamp = (value, minimum = 0, maximum = 1) =>
  Math.max(minimum, Math.min(maximum, value));
export function easeInOut(progress) {
  const clampedProgress = clamp(progress);
  if (clampedProgress < 0.5) {
    return 4 * clampedProgress ** 3;
  }
  return 1 - (-2 * clampedProgress + 2) ** 3 / 2;
}
export function keyBox(keys, renderTime) {
  const [firstKey, lastKey] = keys;
  if (!lastKey || renderTime <= firstKey.t) {
    return firstKey.box;
  }
  if (renderTime >= lastKey.t) {
    return lastKey.box;
  }
  const progress = easeInOut((renderTime - firstKey.t) / (lastKey.t - firstKey.t));
  return firstKey.box.map((coordinate, index) => {
    const interpolated = coordinate + (lastKey.box[index] - coordinate) * progress;
    return Math.round(interpolated * 10) / 10;
  });
}
export const keepAfterNewVersion = (overrides, sentSnapshot) =>
  Object.fromEntries(
    Object.entries(overrides).filter(
      ([k, v]) => JSON.stringify(sentSnapshot[k]) !== JSON.stringify(v),
    ),
  );
export function indexProject(project) {
  const scenes = new Map(project.scenes.map((scene) => [scene.id, scene]));
  const elements = new Map(
    project.scenes.flatMap((scene) =>
      scene.els.map((element) => [
        element.id,
        {
          element: element,
          scene: scene.id,
        },
      ]),
    ),
  );
  return {
    sceneOf: (id) => scenes.get(id),
    elById: (id) => {
      const entry = elements.get(id);
      return (
        entry && {
          ...entry.element,
          s: entry.scene,
        }
      );
    },
    allEls: () =>
      [...elements.values()].map(({ element, scene }) => ({
        ...element,
        s: scene,
      })),
  };
}
export function pathExists(project, index, key) {
  if (key.startsWith('brand.color.')) {
    return !!project.brand?.colors?.some((c) => c.id === key.slice(12));
  }
  if (key.startsWith('brand.font.')) {
    return !!project.brand?.fonts?.some((f) => f.id === key.slice(11));
  }
  if (key === 'brand.logo' || key.startsWith('audio.')) {
    return true;
  }
  const [id, field = ''] = key.split('.');
  if (field === '@len') {
    return !!index.sceneOf(id);
  }
  const element = index.elById(id);
  if (!element) {
    return false;
  }
  if (field === '@box' || field === '@keys') {
    return !!element.box;
  }
  return field.startsWith('@') || field in element.props;
}
export function pendingOverrides(overrides, sentSnapshot, exists, realTrim) {
  return Object.entries(overrides).filter(
    ([key, value]) =>
      JSON.stringify(sentSnapshot[key]) !== JSON.stringify(value) &&
      exists(key) &&
      (!key.endsWith('.@len') || realTrim(key)),
  );
}

// Accessors allow edits to update without rebuilding the timeline controller.
export function createTimeline(project, getOverride) {
  const sceneAt = (renderTime) =>
    project.scenes.find((scene) => renderTime < scene.t[1] - 1e-6) || project.scenes.at(-1);
  const sceneLen = (scene) =>
    Math.min(getOverride(`${scene.id}.@len`, scene.t[1] - scene.t[0]), scene.t[1] - scene.t[0]);
  const sceneEnd = (scene) => scene.t[0] + sceneLen(scene);
  const sceneLayout = () => {
    let editedStart = 0;
    return project.scenes.map((scene) => {
      // Preserve layout field names consumed by the editor: source start, length, edited start.
      const entry = {
        s: scene,
        S: scene.t[0],
        L: sceneLen(scene),
        E: editedStart,
      };
      editedStart += entry.L;
      return entry;
    });
  };
  const isCut = (renderTime) => renderTime > sceneEnd(sceneAt(renderTime)) + 1e-6;
  return {
    sceneAt,
    sceneLen,
    sceneEnd,
    sceneLayout,
    isCut,
    edDur: () => project.scenes.reduce((n, s) => n + sceneLen(s), 0),
    toEd(renderTime) {
      const layoutEntry = sceneLayout().find((entry) => entry.s === sceneAt(renderTime));
      return layoutEntry.E + clamp(renderTime - layoutEntry.S, 0, layoutEntry.L);
    },
    toSrc(editedTime) {
      const layout = sceneLayout();
      const layoutEntry = layout.find((o) => editedTime < o.E + o.L) || layout.at(-1);
      return layoutEntry.S + clamp(editedTime - layoutEntry.E, 0, layoutEntry.L);
    },
    nextAfterCut(renderTime) {
      if (!isCut(renderTime)) {
        return null;
      }
      const sceneIndex = project.scenes.indexOf(sceneAt(renderTime));
      return sceneIndex < project.scenes.length - 1 ? project.scenes[sceneIndex + 1].t[0] : -1;
    },
  };
}

export function skeletonMission() {
  return `
    <div class="mission animate-fadeIn">
      <div class="mission-head">
        <div class="body">
          <div class="skeleton" style="height:18px;width:60%;margin-bottom:8px"></div>
          <div class="skeleton" style="height:12px;width:40%"></div>
        </div>
        <div class="skeleton" style="width:36px;height:36px;border-radius:50%"></div>
      </div>
    </div>`;
}

export function skeletonDriver() {
  return `
    <div class="driver-profile-card animate-fadeIn">
      <div class="dpc-head">
        <div class="skeleton" style="width:44px;height:44px;border-radius:50%"></div>
        <div class="dpc-info" style="flex:1">
          <div class="skeleton" style="height:16px;width:50%;margin-bottom:6px"></div>
          <div class="skeleton" style="height:12px;width:30%"></div>
        </div>
      </div>
    </div>`;
}

export function skeletonList(count = 3, type = 'mission') {
  const fn = type === 'driver' ? skeletonDriver : skeletonMission;
  return Array(count).fill(0).map(() => fn()).join('');
}

export function skeletonPastDay() {
  return `
    <div class="past-day-card animate-fadeIn">
      <div class="pdc-head">
        <div class="skeleton" style="width:52px;height:52px;border-radius:12px"></div>
        <div style="flex:1">
          <div class="skeleton" style="height:14px;width:40%;margin-bottom:6px"></div>
          <div class="skeleton" style="height:11px;width:60%"></div>
        </div>
      </div>
    </div>`;
}

export function skeletonProfile() {
  return `
    <div class="profile-hero animate-fadeIn">
      <div class="skeleton" style="width:60px;height:60px;border-radius:50%"></div>
      <div style="flex:1">
        <div class="skeleton" style="height:22px;width:50%;margin-bottom:8px"></div>
        <div class="skeleton" style="height:14px;width:30%"></div>
      </div>
    </div>`;
}

export function skeletonSheet() {
  return `<div style="padding:16px">${skeletonList(3, 'mission')}</div>`;
}
